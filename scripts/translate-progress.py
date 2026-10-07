#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地翻译控制台（单文件、零依赖，仅 Python 标准库）：
实时进度 + 网页更换 AI API Key + 网页重启翻译任务。

启动：python3 scripts/translate-progress.py [--port 39598]
查看：http://127.0.0.1:39598 （页面每 3 秒自动刷新）

安全：绑定 0.0.0.0（用户要求局域网可访问）——本页可以改密钥、重启任务，
局域网内任何人都能操作，请确保只在可信网络使用。

数据/控制面（全部本地、gitignored）：
  data/translate-ai-local.state          wrapper 状态 running|done|deadline
  data/translate-ai-local.progress.json  当前运行统计（翻译脚本每 30s 刷新）
  data/translate-ai-local.log            追加日志（解析 ⏱ 状态行与最近活动）
  data/statements/*.json                 题面真值：逐段统计 ai 渠道覆盖（15s 缓存）
  .env.local                             AI_BASE_URL / AI_API_KEY / AI_MODEL（网页可改 AI_API_KEY）
  ~/Library/LaunchAgents/org.ysproblem.translate-ai.plist  翻译任务 agent（网页重启按钮走它）
"""
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STATE_FILE = DATA / "translate-ai-local.state"
PROGRESS_FILE = DATA / "translate-ai-local.progress.json"
LOG_FILE = DATA / "translate-ai-local.log"
WRAPPER_SH = DATA / "translate-ai-wrapper.sh"
PLATFORMS_FILE = DATA / "translate-platforms.json"
ENV_FILE = ROOT / ".env.local"  # 旧版单平台配置，platforms.json 缺失时的回退
TASK_PLIST = Path.home() / "Library" / "LaunchAgents" / "org.ysproblem.translate-ai.plist"
STATEMENTS_GLOB = str(DATA / "statements" / "*.json")

DEFAULT_BASE_URL = "https://discovery-api.intern-ai.org.cn"
DEFAULT_MODEL = "glm-5.3"

TRUTH_TTL = 15  # statements 真值扫描缓存秒数
LOG_TAIL_BYTES = 256 * 1024

# ---- 访问密码：从 gitignored 的 data/panel-password.txt 读取，首次运行自动
# 写入默认值 qwe123（保持既有部署可用）。仓库是公开的、控制台又暴露在公网隧道
# 后面，而本页可以改 API key / 重启任务，所以口令绝不能硬编码进源码——
# 想换密码直接改那个文件，重启控制台生效。
PANEL_PASSWORD_FILE = DATA / "panel-password.txt"


def _load_panel_password() -> str:
    try:
        pwd = PANEL_PASSWORD_FILE.read_text(encoding="utf-8").strip()
        if pwd:
            return pwd
    except OSError:
        pass
    pwd = "qwe123"
    try:
        PANEL_PASSWORD_FILE.write_text(pwd + "\n", encoding="utf-8")
        print(f"已初始化访问密码文件 {PANEL_PASSWORD_FILE}（默认 qwe123，建议改成强口令）", flush=True)
    except OSError as e:
        print(f"警告：无法写入密码文件（{e}），使用默认口令", flush=True)
    return pwd


PANEL_PASSWORD = _load_panel_password()
AUTH_COOKIE = "yspanel"
AUTH_TOKEN = hashlib.sha256(f"ysproblem-panel:{PANEL_PASSWORD}".encode()).hexdigest()

LOGIN_PAGE = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>控制台登录</title>
<style>
 body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f1115;color:#d7dce4;font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
 .box{background:#171c26;border:1px solid #2c3442;border-radius:12px;padding:28px;width:320px}
 h1{font-size:17px;margin:0 0 6px} .sub{color:#8a93a3;font-size:12px;margin-bottom:16px}
 input{width:100%;box-sizing:border-box;background:#10141b;border:1px solid #2c3442;color:#d7dce4;border-radius:8px;padding:9px 11px;font-size:14px;margin-bottom:12px}
 button{width:100%;background:#2f81f7;border:none;color:#fff;border-radius:8px;padding:9px;font-size:14px;cursor:pointer}
 .err{color:#ff7b72;font-size:12px;margin:-4px 0 10px;display:none}
</style></head>
<body><div class="box"><h1>AI 翻译控制台</h1><div class="sub">请输入访问密码</div>
<div class="err" id="e">密码错误，请重试</div>
<form method="POST" action="/login"><input type="password" name="password" placeholder="访问密码" autofocus><button>进入</button></form>
</div></body></html>"""

_truth_cache = {"at": 0.0, "data": None}

# ---------------------------------------------------------------- 真值统计

def scan_truth():
    """逐段统计 data/statements/*.json 的 ai 渠道覆盖（与 node 版 missingSegments 同语义）。"""
    now = time.time()
    if _truth_cache["data"] and now - _truth_cache["at"] < TRUTH_TTL:
        return _truth_cache["data"]

    def covered(entry) -> bool:
        if isinstance(entry, str):
            return True  # 旧版整段字符串翻译视为已覆盖
        return isinstance(entry, dict) and isinstance(entry.get("ai"), str) and bool(entry["ai"].strip())

    seg_total = seg_missing = 0
    files_total = files_missing = 0
    for path in glob.glob(STATEMENTS_GLOB):
        try:
            with open(path, encoding="utf-8") as f:
                st = json.load(f)
        except (OSError, ValueError):
            continue
        files_total += 1
        file_missing = 0
        title = st.get("title")
        if isinstance(title, str) and title.strip():
            seg_total += 1
            if not covered(st.get("titleZh")):
                file_missing += 1
        sections = st.get("sections")
        sections_zh = st.get("sectionsZh")
        if isinstance(sections, dict):
            for key, paras in sections.items():
                if not isinstance(paras, list):
                    continue
                zh_list = sections_zh.get(key) if isinstance(sections_zh, dict) else None
                for i, para in enumerate(paras):
                    if not isinstance(para, str) or not para.strip():
                        continue
                    seg_total += 1
                    entry = zh_list[i] if isinstance(zh_list, list) and i < len(zh_list) else None
                    if not covered(entry):
                        file_missing += 1
        seg_missing += file_missing
        if file_missing:
            files_missing += 1
    data = {
        "scannedAt": time.strftime("%F %T"),
        "filesTotal": files_total,
        "filesMissing": files_missing,
        "segTotal": seg_total,
        "segCovered": seg_total - seg_missing,
        "segMissing": seg_missing,
    }
    _truth_cache.update(at=now, data=data)
    return data

# ---------------------------------------------------------------- 日志解析

def read_tail_lines(nbytes=LOG_TAIL_BYTES):
    try:
        size = LOG_FILE.stat().st_size
        with open(LOG_FILE, "rb") as f:
            f.seek(max(0, size - nbytes))
            return f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return []


STATUS_RE = re.compile(
    r"近2分钟 (?P<rate>[\d.]+) 段/s → ETA (?P<eta>[\d:—\-]+) .*?"
    r"tokens in=(?P<tin>[\d,]+) out=(?P<tout>[\d,]+) cached=(?P<tcached>[\d,]+)"
)


def last_status(lines):
    for line in reversed(lines):
        if line.startswith("⏱"):
            m = STATUS_RE.search(line)
            parsed = {}
            if m:
                num = lambda s: int(s.replace(",", ""))
                parsed = {
                    "ratePerSec": float(m.group("rate")),
                    "eta": m.group("eta"),
                    "tokensIn": num(m.group("tin")),
                    "tokensOut": num(m.group("tout")),
                    "tokensCached": num(m.group("tcached")),
                }
            return {"line": line, **parsed}
    return None


ACTIVITY_PREFIX = ("✓", "✗", "⛔", "✅", "⧗", "⚠", "═", "──")


def recent_activity(lines, limit=16):
    return [ln for ln in lines if ln.startswith(ACTIVITY_PREFIX)][-limit:]


def node_process():
    try:
        out = subprocess.run(
            ["pgrep", "-f", r"translate-ai-local\.mjs"],
            capture_output=True, text=True, timeout=5,
        )
        pids = sorted(int(x) for x in out.stdout.split() if x.strip().isdigit())
        return {"running": bool(pids), "pid": pids[0] if pids else None}
    except Exception:
        return {"running": False, "pid": None}

# ---------------------------------------------------------------- 平台配置

ENV_KEYS = ("AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_LABEL")


def _legacy_env_platform():
    """platforms.json 缺失时从 .env.local 合成单平台（向后兼容）。"""
    vals = {}
    try:
        for ln in ENV_FILE.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$", ln)
            if m and m.group(1) in ENV_KEYS:
                vals[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    except OSError:
        return []
    if not vals.get("AI_BASE_URL") or not vals.get("AI_API_KEY"):
        return []
    return [{
        "name": "default",
        "baseUrl": vals["AI_BASE_URL"].rstrip("/"),
        "key": vals["AI_API_KEY"],
        "model": vals.get("AI_MODEL") or "glm-5.3",
        "label": vals.get("AI_MODEL_LABEL") or "",
        "enabled": True,
    }]


def read_platforms():
    try:
        j = json.loads(PLATFORMS_FILE.read_text(encoding="utf-8"))
        return list(j.get("platforms") or [])
    except (OSError, ValueError):
        return _legacy_env_platform()


def write_platforms(plats):
    PLATFORMS_FILE.write_text(
        json.dumps({"platforms": plats}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def mask_key(k):
    return f"{k[:6]}…{k[-4:]}" if len(k) > 12 else "…"


def save_platforms(incoming):
    """保存平台列表；key 留空 = 按平台名保留现有 key。返回 (cleaned, error)。"""
    old = {p.get("name"): p for p in read_platforms()}
    cleaned = []
    for i, pl in enumerate(incoming):
        if not isinstance(pl, dict):
            return None, "平台条目格式错误"
        name = str(pl.get("name") or "").strip() or f"platform-{i + 1}"
        base = str(pl.get("baseUrl") or "").strip().rstrip("/")
        model = str(pl.get("model") or "").strip()
        label = str(pl.get("label") or "").strip()
        key = str(pl.get("key") or "").strip()
        if not base.startswith(("http://", "https://")):
            return None, f"平台 {name}：URL 需以 http(s):// 开头"
        if not key:
            key = str(old.get(name, {}).get("key") or "")
        if not key or not model:
            return None, f"平台 {name}：key/model 不能为空（key 留空仅在平台已存在时有效）"
        cleaned.append({
            "name": name, "baseUrl": base, "key": key, "model": model,
            "label": label, "enabled": bool(pl.get("enabled", True)),
        })
    names = [p["name"] for p in cleaned]
    if len(names) != len(set(names)):
        return None, "平台名重复"
    write_platforms(cleaned)
    return cleaned, None


def test_key(key, base_url=None, model=None):
    """对端点发一次 max_tokens=1 的最小请求，判定 key 是否有效/配额状态。"""
    base = (base_url or DEFAULT_BASE_URL).rstrip("/")
    url = base + ("/chat/completions" if re.search(r"/v\d+$", base) else "/v1/chat/completions")
    body = json.dumps({
        "model": model or DEFAULT_MODEL,
        "temperature": 0.1,
        "reasoning": False,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "hi"}],
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            u = (json.loads(resp.read().decode("utf-8", "replace")) or {}).get("usage") or {}
            return {"ok": True, "http": 200, "detail": f"key 有效，请求成功（prompt_tokens={u.get('prompt_tokens', '?')}）"}
    except urllib.error.HTTPError as e:
        detail = e.read()[:200].decode("utf-8", "replace")
        if e.code == 429:
            return {"ok": True, "http": 429,
                    "detail": "key 有效但配额耗尽/限流中（429）——任务会自动等待恢复，无需换 key" if "quota" in detail.lower()
                    else "限流中（429）：" + detail}
        if e.code in (401, 403):
            return {"ok": False, "http": e.code, "detail": "认证失败（key 无效或无权限）"}
        return {"ok": False, "http": e.code, "detail": detail}
    except Exception as e:
        return {"ok": False, "http": 0, "detail": f"请求失败：{e}"}


def restart_task():
    """重启翻译任务：优先走 launchctl 重载 agent（新 4h 窗口），否则脱离会话直接拉起 wrapper。"""
    subprocess.run(["pkill", "-f", r"translate-ai-local\.mjs"], capture_output=True)
    subprocess.run(["pkill", "-f", "translate-ai-wrapper.sh"], capture_output=True)
    time.sleep(1.2)
    if TASK_PLIST.exists():
        subprocess.run(["launchctl", "unload", str(TASK_PLIST)], capture_output=True)
        time.sleep(0.5)
        r = subprocess.run(["launchctl", "load", str(TASK_PLIST)], capture_output=True, text=True)
        if r.returncode == 0:
            time.sleep(2)
            return {"ok": True, "how": "launchctl", "detail": "已通过 launchctl 重载（常驻模式：异常自动重启直到翻译完成，已重读平台配置）"}
    if WRAPPER_SH.exists():
        subprocess.Popen(["/bin/bash", str(WRAPPER_SH)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        time.sleep(2)
        return {"ok": True, "how": "detached", "detail": "launchctl 不可用，已脱离会话直接拉起 wrapper"}
    return {"ok": False, "how": None, "detail": "找不到 plist 与 wrapper 脚本，请手动启动"}

# ---------------------------------------------------------------- 状态聚合

def build_status():
    lines = read_tail_lines()
    try:
        state = STATE_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        state = "unknown"
    run = None
    try:
        run = json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
        run["ageSeconds"] = round(time.time() - os.path.getmtime(PROGRESS_FILE), 1)
    except (OSError, ValueError):
        pass
    plats = read_platforms()
    return {
        "now": time.strftime("%F %T"),
        "state": state,
        "node": node_process(),
        "truth": scan_truth(),
        "run": run,
        "lastStatus": last_status(lines),
        "recent": recent_activity(lines),
        "quotaExhausted": any("配额耗尽" in ln for ln in lines[-8:]),
        "platformsConfig": [
            {
                "name": p.get("name") or "?",
                "baseUrl": p.get("baseUrl") or "",
                "model": p.get("model") or "",
                "label": p.get("label") or "",
                "enabled": p.get("enabled", True),
                "keyMasked": mask_key(p.get("key") or "") if p.get("key") else "未设置",
            }
            for p in plats
        ],
    }

# ---------------------------------------------------------------- 页面

PAGE = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 翻译控制台</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:#0f1115; color:#d7dce4; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:13px; color:#8a93a3; margin:0 0 8px; font-weight:500; }
  .sub { color:#8a93a3; font-size:12px; margin-bottom:18px; }
  .badges { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
  .badge { padding:3px 12px; border-radius:999px; font-size:12px; border:1px solid #2c3442; background:#171c26; }
  .badge.green { color:#5dd39e; border-color:#245a41; }
  .badge.red { color:#ff7b72; border-color:#6b2e2b; }
  .badge.amber { color:#e3b341; border-color:#6b5420; }
  .bar-outer { height:26px; border-radius:8px; background:#171c26; border:1px solid #2c3442; overflow:hidden; margin-bottom:6px; }
  .bar-inner { height:100%; background:linear-gradient(90deg,#2f81f7,#5dd39e); width:0; transition:width .6s ease; }
  .bar-label { display:flex; justify-content:space-between; font-size:13px; color:#aeb7c6; margin-bottom:18px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:18px; }
  .card { background:#171c26; border:1px solid #2c3442; border-radius:10px; padding:10px 14px; }
  .card .k { font-size:11px; color:#8a93a3; }
  .card .v { font-size:18px; font-weight:600; margin-top:2px; word-break:break-all; }
  .banner { padding:10px 14px; border-radius:10px; margin-bottom:16px; font-size:13px; display:none; }
  .banner.quota { display:block; background:#2a1d1a; border:1px solid #6b2e2b; color:#ff9d95; }
  .banner.warn { display:block; background:#2a2417; border:1px solid #6b5420; color:#e3b341; }
  .controls { background:#171c26; border:1px solid #2c3442; border-radius:10px; padding:14px 16px; margin-bottom:18px; }
  .controls .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
  .controls code { color:#5dd39e; background:#10141b; padding:2px 8px; border-radius:6px; }
  .controls .hint { color:#5b6472; font-size:11px; margin-top:8px; }
  .plat-row { display:grid; grid-template-columns: 110px minmax(180px,1.2fr) minmax(160px,1fr) minmax(130px,0.9fr) minmax(110px,0.7fr) auto auto auto; gap:6px; align-items:center; margin-top:8px; }
  .plat-row input[type=text], .plat-row input[type=password] { width:100%; min-width:0; background:#10141b; border:1px solid #2c3442; color:#d7dce4; border-radius:8px; padding:6px 8px; font-size:12px; }
  .plat-row .en { display:flex; align-items:center; gap:4px; font-size:12px; color:#aeb7c6; }
  .plat-head { display:grid; grid-template-columns: 110px minmax(180px,1.2fr) minmax(160px,1fr) minmax(130px,0.9fr) minmax(110px,0.7fr) auto auto auto; gap:6px; font-size:11px; color:#8a93a3; margin-top:10px; }
  button { background:#2f81f7; border:none; color:#fff; border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; }
  button.secondary { background:#242b38; border:1px solid #2c3442; color:#c6cedb; }
  button.mini { padding:5px 10px; font-size:12px; }
  button.danger { background:#3a2226; border:1px solid #6b2e2b; color:#ff9d95; }
  button:disabled { opacity:.5; cursor:default; }
  #ctlMsg { font-size:12px; color:#aeb7c6; word-break:break-all; }
  table.stats { width:100%; border-collapse:collapse; background:#171c26; border:1px solid #2c3442; border-radius:10px; overflow:hidden; font-size:12px; }
  table.stats th, table.stats td { padding:6px 10px; text-align:left; border-bottom:1px solid #232a36; }
  table.stats th { color:#8a93a3; font-weight:500; }
  table.stats tr:last-child td { border-bottom:none; }
  .st-ok { color:#5dd39e; } .st-wait { color:#e3b341; } .st-dead { color:#ff7b72; }
  pre { background:#171c26; border:1px solid #2c3442; border-radius:10px; padding:12px 14px; font:12px/1.7 ui-monospace,Menlo,monospace; overflow:auto; max-height:340px; white-space:pre-wrap; word-break:break-all; margin:0; }
  .foot { margin-top:14px; font-size:11px; color:#5b6472; }
</style>
</head>
<body>
<div class="wrap">
  <h1>AI 翻译控制台</h1>
  <div class="sub">scripts/translate-ai-local.mjs · 真值每 15s 重扫 · 页面每 3s 自动刷新 · 局域网可访问（可改密钥，限可信网络）</div>
  <div class="badges" id="badges"></div>
  <div class="banner quota" id="bannerQuota">⛔ 配额耗尽（quota exceeded）——任务处于侦察兵等待模式，配额回血后自动恢复；也可在下方更换其他 key 后重启任务</div>
  <div class="banner warn" id="bannerWarn"></div>
  <div class="bar-outer"><div class="bar-inner" id="bar"></div></div>
  <div class="bar-label"><span id="barText"></span><span id="barPct"></span></div>
  <div class="cards" id="cards"></div>

  <h2>平台状态（本次运行）</h2>
  <table class="stats" id="platStats"><tr><th>平台</th><th>模型</th><th>并发</th><th>成功/失败</th><th>tokens(in/out/cached)</th><th>429</th><th>状态</th></tr></table>

  <div class="controls">
    <h2>翻译平台（多平台并行，共享同一条任务队列）</h2>
    <div class="plat-head"><span>名称</span><span>平台 URL</span><span>API Key</span><span>模型</span><span>显示名</span><span>启用</span><span></span><span></span></div>
    <div id="platList"></div>
    <div class="row">
      <button class="secondary mini" onclick="addPlatform()">＋ 添加平台</button>
      <button class="secondary mini" onclick="savePlatforms()">保存全部平台</button>
      <span class="envmeta" id="platMsg"></span>
    </div>
    <div class="hint">Key 列留空 = 保留该平台现有密钥（占位符显示打码后的现值）。保存后点「重启翻译任务」生效（断点续传不丢进度）。每个平台有独立的并发与限流闸门：某平台配额耗尽时其余平台照常推进。任务常驻运行：node 异常退出自动重启，直到全部翻译完成。</div>
  </div>

  <div class="controls">
    <h2>任务控制</h2>
    <div class="row">
      <button id="restartBtn" onclick="restartTask()">重启翻译任务</button>
      <button class="secondary" onclick="testForm()">测试表单中的平台</button>
      <span id="ctlMsg"></span>
    </div>
    <div class="hint">「测试表单中的平台」用编辑区当前值发一次最小请求（先测后存）。</div>
  </div>

  <h2>最近活动（日志尾部）</h2>
  <pre id="recent">加载中…</pre>
  <div class="foot" id="foot"></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n ?? 0).toLocaleString("en-US");
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");

function badge(text, cls) { return `<span class="badge ${cls||""}">${esc(text)}</span>`; }

function render(d) {
  const t = d.truth || {};
  const covered = t.segCovered || 0, total = t.segTotal || 0;
  const pct = total ? (covered / total * 100) : 0;
  $("bar").style.width = pct.toFixed(2) + "%";
  $("barText").textContent = `已翻译 ${fmt(covered)} / ${fmt(total)} 段（真值统计 ${t.scannedAt||""}）`;
  $("barPct").textContent = pct.toFixed(1) + "%";

  const bs = [];
  const stateText = { running: "wrapper 运行中", done: "已完成", deadline: "窗口到期", unknown: "无状态文件" }[d.state] || d.state;
  bs.push(badge(stateText, d.state === "running" || d.state === "done" ? "green" : "amber"));
  bs.push(badge(d.node && d.node.running ? `node 存活 pid=${d.node.pid}` : "node 未运行", d.node && d.node.running ? "green" : "red"));
  if (d.quotaExhausted) bs.push(badge("配额等待中", "amber"));
  if (d.run && d.run.quotaDead) bs.push(badge("配额死置（将退出重跑）", "red"));
  $("badges").innerHTML = bs.join("");

  $("bannerQuota").style.display = d.quotaExhausted ? "block" : "none";
  const warn = $("bannerWarn");
  if (d.state === "deadline") { warn.className = "banner warn"; warn.textContent = "⚠ 任务曾到达窗口上限——点上方「重启翻译任务」续传"; }
  else if (d.node && !d.node.running && d.state === "running") { warn.className = "banner warn"; warn.textContent = "⚠ wrapper 在但 node 不在（可能在 90s 重启间隔中，若持续如此请检查 launchctl）"; }
  else { warn.className = "banner"; warn.textContent = ""; }

  const ls = d.lastStatus || {};
  const r = d.run || {};
  const cards = [
    ["已翻译（真值）", fmt(covered)],
    ["剩余缺口", fmt(t.segMissing ?? "—")],
    ["文件缺口", `${fmt(t.filesMissing ?? 0)} / ${fmt(t.filesTotal ?? 0)}`],
    ["本次运行", `${fmt(r.done ?? 0)} / ${fmt(r.total ?? 0)}`],
    ["成功 / 失败", `✓${fmt(r.ok ?? 0)} ✗${fmt(r.fail ?? 0)}`],
    ["速率", (ls.ratePerSec !== undefined ? ls.ratePerSec.toFixed(2) + " 段/s" : "—")],
    ["ETA", ls.eta || "—"],
    ["并发（峰值）", r.concurrency !== undefined ? `${r.concurrency}（${r.peakConcurrency ?? "?"}）` : "—"],
    ["429 / 重试", `${fmt(r.hits429 ?? 0)} / ${fmt(r.retries ?? 0)}`],
    ["配额暂停次数", fmt(r.quotaPauses ?? 0)],
    ["tokens（输入）", fmt(ls.tokensIn)],
    ["tokens（输出/缓存）", `${fmt(ls.tokensOut)} / ${fmt(ls.tokensCached)}`],
  ];
  $("cards").innerHTML = cards.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${esc(String(v))}</div></div>`).join("");

  const env = d.platformsConfig || [];
  // 平台状态表（来自 progress.json 的 platforms 数组）
  const tbl = $("platStats");
  const rows = (r.platforms || []);
  if (!rows.length) {
    tbl.innerHTML = `<tr><td colspan="7">暂无运行数据</td></tr>`;
  } else {
    tbl.innerHTML = `<tr><th>平台</th><th>模型</th><th>并发</th><th>成功/失败</th><th>tokens(in/out/cached)</th><th>429</th><th>状态</th></tr>` +
      rows.map((p) => {
        const st = p.dead ? `<span class="st-dead">已下线 ${esc(p.deadReason || "")}</span>`
          : p.quotaDead ? `<span class="st-dead">配额放弃</span>`
          : p.quotaWaiting ? `<span class="st-wait">⛔ 配额等待</span>`
          : `<span class="st-ok">运行中</span>`;
        return `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.model)}</td><td>${p.conc}（峰值 ${p.peakConc}）</td>` +
          `<td><span class="st-ok">✓${fmt(p.ok)}</span> / ✗${fmt(p.fail)}</td>` +
          `<td>${fmt(p.in)} / ${fmt(p.out)} / ${fmt(p.cached)}</td>` +
          `<td>${fmt(p.hits429)}</td><td>${st}</td></tr>`;
      }).join("");
  }

  $("recent").textContent = (d.recent && d.recent.length ? d.recent.join("\\n") : "暂无活动日志");
  const age = r.ageSeconds;
  $("foot").textContent = `刷新于 ${d.now} · progress.json 更新于 ${age !== undefined ? age + "s 前" : "—"} · 页面每 3s 自动刷新`;
}

async function tick() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (res.status === 401) { location.href = "/login"; return; }
    render(await res.json());
  } catch (e) { $("foot").textContent = "拉取状态失败：" + e.message; }
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (res.status === 401) { location.href = "/login"; return { ok: false, error: "未登录" }; }
  return res.json();
}

function msg(text) { $("ctlMsg").textContent = text; }

// ---- 平台编辑器 ----
let platRows = [];

async function loadPlatforms() {
  try {
    const res = await fetch("/api/platforms", { cache: "no-store" });
    if (res.status === 401) { location.href = "/login"; return; }
    const j = await res.json();
    platRows = (j.platforms || []).map((p) => ({ ...p, key: "" }));
    renderPlatforms();
  } catch (e) { platMsg("加载平台配置失败：" + e.message); }
}

function renderPlatforms() {
  const box = $("platList");
  box.innerHTML = "";
  platRows.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "plat-row";
    div.innerHTML = `
      <input type="text" data-f="name" value="${esc(p.name)}" placeholder="名称">
      <input type="text" data-f="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://…/v1">
      <input type="password" data-f="key" value="" placeholder="${esc(p.keyMasked || "API Key")}" autocomplete="off">
      <input type="text" data-f="model" value="${esc(p.model)}" placeholder="模型 id">
      <input type="text" data-f="label" value="${esc(p.label || "")}" placeholder="显示名（可选）">
      <label class="en"><input type="checkbox" data-f="enabled" ${p.enabled !== false ? "checked" : ""}>启用</label>
      <button class="secondary mini" onclick="testRow(${i})">测试</button>
      <button class="danger mini" onclick="removeRow(${i})">删除</button>`;
    box.appendChild(div);
  });
}

function collectPlatforms() {
  return [...document.querySelectorAll("#platList .plat-row")].map((row) => {
    const get = (f) => { const el = row.querySelector(`[data-f="${f}"]`); return el ? (el.type === "checkbox" ? el.checked : el.value.trim()) : ""; };
    return { name: get("name"), baseUrl: get("baseUrl"), key: get("key"), model: get("model"), label: get("label"), enabled: get("enabled") };
  });
}

function platMsg(text) { $("platMsg").textContent = text; }

function addPlatform() {
  platRows.push({ name: "", baseUrl: "", key: "", model: "", label: "", enabled: true, keyMasked: "" });
  renderPlatforms();
}

function removeRow(i) {
  if (!confirm(`删除平台 ${platRows[i].name || i + 1}？（保存后生效）`)) return;
  platRows.splice(i, 1);
  renderPlatforms();
}

async function savePlatforms() {
  const r = await post("/api/platforms", { platforms: collectPlatforms() });
  if (r.ok) {
    platMsg(`已保存：${(r.updated || []).join("、")} —— 点「重启翻译任务」生效`);
    await loadPlatforms();
  } else platMsg(`保存失败：${r.error || "?"}`);
}

async function testRow(i) {
  const vals = collectPlatforms()[i];
  platMsg(`测试 ${vals.name || "未命名平台"} 中…`);
  const r = await post("/api/test-key", vals); // key 留空时服务端回退该平台已保存的 key
  platMsg(`[${vals.name || "?"}] [HTTP ${r.http}] ${r.detail}${r.ok ? "（可用）" : "（不可用）"}`);
}

async function testForm() {
  const rows = collectPlatforms();
  if (!rows.length) { platMsg("没有可测试的平台"); return; }
  await testRow(0);
}

async function restartTask() {
  if (!confirm("重启翻译任务？（重读平台配置，断点续传不丢进度）")) return;
  $("restartBtn").disabled = true;
  msg("重启中…");
  try {
    const r = await post("/api/restart", {});
    msg(r.ok ? `已重启（${r.how}）：${r.detail}` : `重启失败：${r.detail || "?"}`);
  } catch (e) { msg("重启失败：" + e.message); }
  $("restartBtn").disabled = false;
  setTimeout(tick, 1500);
}

tick();
loadPlatforms();
setInterval(tick, 3000);
</script>
</body>
</html>
"""

# ---------------------------------------------------------------- HTTP 服务

class Handler(BaseHTTPRequestHandler):
    def _send(self, body, code=200, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _cookies(self):
        out = {}
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _authed(self):
        return self._cookies().get(AUTH_COOKIE) == AUTH_TOKEN

    def _login_ok(self):
        # HttpOnly + Path=/；不加 Secure（局域网 http 与隧道 https 都要能用）
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header(
            "Set-Cookie",
            f"{AUTH_COOKIE}={AUTH_TOKEN}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax",
        )
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _unauth(self):
        self._send({"ok": False, "error": "unauthorized"}, code=401)

    def do_GET(self):
        try:
            if self.path == "/login":
                if self._authed():
                    self.send_response(303)
                    self.send_header("Location", "/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._send(LOGIN_PAGE.encode("utf-8"), ctype="text/html; charset=utf-8")
            elif self.path == "/" or self.path.startswith("/?"):
                if not self._authed():
                    self.send_response(303)
                    self.send_header("Location", "/login")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self._send(PAGE.encode("utf-8"), ctype="text/html; charset=utf-8")
            elif self.path.startswith("/api/"):
                if not self._authed():
                    self._unauth()
                    return
                if self.path.startswith("/api/status"):
                    self._send(build_status())
                elif self.path.startswith("/api/platforms"):
                    self._send({
                        "ok": True,
                        "platforms": [
                            {
                                "name": p.get("name") or "",
                                "baseUrl": p.get("baseUrl") or "",
                                "model": p.get("model") or "",
                                "label": p.get("label") or "",
                                "enabled": p.get("enabled", True),
                                "keyMasked": mask_key(p.get("key") or "") if p.get("key") else "",
                            }
                            for p in read_platforms()
                        ],
                    })
                else:
                    self._send(b"not found", code=404, ctype="text/plain")
            else:
                self._send(b"not found", code=404, ctype="text/plain")
        except Exception as e:
            self._send({"ok": False, "error": str(e)}, code=500)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) or b""
            if self.path == "/login":
                form = parse_qs(raw.decode("utf-8", "replace"))
                pwd = (form.get("password") or [""])[0]
                if pwd == PANEL_PASSWORD:
                    self._login_ok()
                else:
                    # 回登录页，并让错误提示可见
                    self._send(
                        LOGIN_PAGE.replace(
                            '<div class="err" id="e">密码错误，请重试</div>',
                            '<div class="err" id="e" style="display:block">密码错误，请重试</div>',
                        ).encode("utf-8"),
                        ctype="text/html; charset=utf-8",
                    )
                return
            try:
                payload = json.loads(raw or b"{}")
            except ValueError:
                payload = {}
            if not self._authed():
                self._unauth()
                return
            if self.path == "/api/platforms":
                cleaned, err = save_platforms(payload.get("platforms") or [])
                if err:
                    self._send({"ok": False, "error": err})
                    return
                self._send({
                    "ok": True,
                    "updated": [p["name"] for p in cleaned],
                    "masked": {p["name"]: mask_key(p["key"]) for p in cleaned},
                    "detail": "已写入 data/translate-platforms.json，点「重启翻译任务」生效",
                })
            elif self.path == "/api/test-key":
                key = str(payload.get("key") or "").strip()
                base = str(payload.get("baseUrl") or "").strip()
                model = str(payload.get("model") or "").strip()
                name = str(payload.get("name") or "").strip()
                if not key or not base or not model:
                    # 表单值不全 → 回退已保存的平台（按名匹配，否则取第一个）
                    saved = {p.get("name"): p for p in read_platforms()}
                    src = saved.get(name) or next(iter(saved.values()), None)
                    if src:
                        key = key or str(src.get("key") or "")
                        base = base or str(src.get("baseUrl") or "")
                        model = model or str(src.get("model") or "")
                if not key or not base or not model:
                    self._send({"ok": False, "http": 0, "detail": "测试需要 baseUrl/key/model（表单或已保存平台均未提供完整三项）"})
                    return
                self._send(test_key(key, base, model))
            elif self.path == "/api/restart":
                self._send(restart_task())
            else:
                self._send(b"not found", code=404, ctype="text/plain")
        except Exception as e:
            self._send({"ok": False, "error": str(e)}, code=500)

    def log_message(self, *args):
        pass  # 静默访问日志


def main():
    port = 39598
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"AI 翻译控制台: http://127.0.0.1:{port}（0.0.0.0 绑定，局域网可用 <本机IP>:{port} 访问）", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
