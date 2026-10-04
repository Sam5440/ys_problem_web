# AGENTS.md

给 AI 编码代理的仓库指南。改动前先读一遍，尤其是「高频坑」。

## 项目概览

Codeforces 每日两题镜像站（数据来自上游 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems)）：Next.js 15 App Router + Tailwind CSS v4 + 手写 shadcn 风格组件（`components/ui/`）+ KaTeX + marked，**全站静态预渲染**，Vercel 自动部署。数据由 GitHub Action 每小时轮询上游自动更新。

## 常用命令

```bash
npm run dev            # 开发服务器
npx next build         # 生产构建（跳过 prebuild；npm run build 会先从上游拉数据并可能改写 data/daily.json）
npm run reattach       # 把 data/statements/*.json 重新挂载进 data/daily.json
npm run update-data    # 同步上游（CF_STATEMENTS=0 TRANSLATE=0 等环境变量控制子步骤）
node scripts/fetch-statements.mjs --limit N   # 补抓题面（续传式）
node scripts/translate-ai.mjs                 # AI 翻译回填（需 AI_BASE_URL/AI_API_KEY）
node scripts/repair-zsmj.mjs --limit N        # 重抓 ZSMJ 污染题面
node scripts/save-ci-log.mjs                  # 仅在 Actions 内可用（依赖 GITHUB_* env，缺了会跳过）
```

## 架构与数据流

```
上游仓库 ──(update-data.mjs 每小时 CI)──▶ data/daily.json ◀──(reattach-statements.mjs)── data/statements/*.json
                                            │
                                            ▼
                                   Next.js 静态预渲染（app/）
```

- **站点渲染的是 `data/daily.json` 内嵌的题面副本，不是 statements/*.json**。任何脚本或手工改动 statements 之后，必须跑 `npm run reattach`，否则预渲染页面仍是旧数据（历史上曾因此误判为构建缓存问题）。
- 路由：`/`（今日两题）、`/archive`（全量历史归档）、`/categories`、`/leaderboard`、`/day/[date]`、`/logs`（CI 日志看板）、`/logs/ai-demo`（翻译明细演示页）、`/api/mt/[channel]`（浏览器 MT 跨域中继）。

### 目录地图

| 路径 | 作用 |
|---|---|
| `scripts/update-data.mjs` | 同步上游 problems/题解/排行榜 → `data/daily.json`、`data/leaderboard.json`（全量历史，MAX_DAYS 默认 Infinity） |
| `scripts/lib/cf-statement.mjs` | CF 题面解析器（Playwright 抓取、unmathjax 还原公式） |
| `scripts/fetch-statements.mjs` | 抓题面：无头 Chromium ↔ 有头 Chrome 自适应过 Cloudflare，Xvfb 下运行 |
| `scripts/lib/translate.mjs` + `scripts/translate-statements.mjs` | 四渠道网页版 MT（DeepL/有道/彩云/讯飞，移植 OJBetter，GPL-3.0） |
| `scripts/translate-ai.mjs` | CI 侧 AI 翻译回填（OpenAI 兼容端点），逐段记录 Token，输出 `TOKEN-USAGE` 汇总行 |
| `scripts/repair-zsmj.mjs` | 重抓被旧解析器 `%%ZSMJ%%` 污染的题面（幂等续传） |
| `scripts/save-ci-log.mjs` | CI 第二个 job：日志 + 摘要 + 翻译记录落盘 `public/ci-logs/` |
| `lib/ai-record.mjs` | 构建逐段 原文↔译文 翻译记录（save-ci-log 与 demo 页共用） |
| `lib/mt-protect.js` | 公式/代码/图片占位保护（node 与浏览器同源复用，占位符 `[M07]` 零填充格式） |
| `components/logs-view.jsx` | /logs 仪表盘（手写 SVG 图表，时间轴锚定最新运行而非 Date.now()） |
| `components/ai-translate-detail.jsx` | 逐段原文↔译文对照视图（/logs 运行卡内嵌 + /logs/ai-demo） |
| `public/ci-logs/` | CI 产物三件套：`<日期>-<runId>.log/.json/.ai.json`，滚动 60 天 |
| `data/.upstream-sha` | 上次同步的上游 HEAD，CI 靠它跳过无更新的轮询 |

### CI workflow（`.github/workflows/update-data.yml`，每小时 :12）

双 job：
1. **update**：`git ls-remote` 比对上游 SHA（一致→9 秒空跑结束）→ 同步 → 补抓 4 题 → 修复 ZSMJ（`continue-on-error`；若 `repaired>0 && remaining>0` 用 `gh api .../dispatches` **自链下一轮**——GitHub 并发组只保留最新排队运行，预先排队会被取消，必须 run 内自链）→ AI 翻译回填（预算 60 段，`continue-on-error`）→ 提交 `data/` 并 push（rebase 重试 3 次防竞争）。
2. **save-log**（`needs: update`，`if: !cancelled()`）：job 日志只有完成后才能下载，所以必须独立 job。写 `.log`（清洗 + 400KB 留尾）+ `.json`（摘要含 `tokenUsage`/`tokenSegments`）+ `.ai.json`（逐段翻译记录）。

**GitHub schedule 可靠性极差**：免费公共仓库优先级最低，实测每小时 cron 约 90% 被静默丢弃且不补跑。可靠性依赖手动 `workflow_dispatch` 或自链模式，不要假设定时任务必然执行。公共仓库 Actions 用量免费不限量。

## 翻译体系

- 数据模型：`sectionsZh[key][i] = { deepl, youdao, caiyun, iflyrec, ai }`（对象=多渠道；旧版单字符串视为 `legacy`）。标题在 `titleZh`，结构相同。
- 显示优先级链 `DEFAULT_PRIORITY = ['ai', 'deepl', 'caiyun', 'iflyrec', 'youdao']`（`components/settings.jsx`），用户可拖拽调整；每段译文结尾**始终**注入来源芯片（必须注进 `renderRich` 输出的最后一个 `<p>` 内部，外包 `<p>` 会因非法嵌套被丢弃）。
- 渠道分三类：MT 四渠道由**访客浏览器**实时翻译（`lib/zh-store.js` 轮转分发 + IndexedDB 缓存；DeepL/有道/讯飞走 `/api/mt/[channel]` 同源中继，彩云直连）；`ai`=CI 存档（侧栏「AI (CI翻译)」，无需配置）；`ai_custom`=用户自配端点实时翻译。
- **CI runner 的出口 IP 被四家 MT 服务风控，CI 端 MT 几乎全灭**——缺译文只靠 AI 渠道回填或访客浏览器端翻译，不要试图在 CI 里修 MT。
- 翻译前必须过 `lib/mt-protect.js` 占位保护 `$$$…$$$` 公式、行内代码、图片 markdown、裸 URL；AI 响应要做占位还原校验（`restoreMath` 返回空即判失败）。

## Token 与翻译记录

- `translate-ai.mjs` 每段日志：`✓ key[i]: 译文… [tokens in=X out=Y]`；结束打印 `TOKEN-USAGE {model,ok,fail,in,out,segments[],totalTokens}` 单行 JSON。
- `save-ci-log.mjs` 解析进摘要 `summary.tokenUsage` + `summary.tokenSegments`（`summarize` 已导出可单测；env 检查在 `main()` 内而非模块顶层，避免 import 即退出）。
- `.ai.json` 翻译记录：`{ runId, startedAt, tokenUsage, tokensBySeg: {"<code>:<seg>[i]": {in,out}}, problems: [{code,title,segs:[{key,i,en,zh}],aiCount}] }`。构建自当时的 statements 快照（ai 段即该次运行写入的译文）。
- /logs 相关约定：`app/logs/page.jsx` 与 `app/logs/ai-demo/page.jsx` 的 `loadRuns()` **必须排除 `.ai.json`**（只列 `.json` 摘要），运行卡展开时才懒加载对应 `.ai.json`。

## Secrets 与环境变量

- 仓库 Secrets：`AI_BASE_URL`、`AI_API_KEY`（OpenAI 兼容端点，CI AI 翻译用）；`AI_MODEL`、`AI_TRANSLATE_LIMIT` 写死在 workflow 里。设置方法：`gh secret set 名字 < 本地文件`，避免密钥进会话记录。
- 脚本开关：`CF_STATEMENTS=0`（跳过挂载题面）、`TRANSLATE=0`（跳过 MT）、`MAX_DAYS`（历史保留天数，默认无限）、`CF_START_MODE=chrome-headful`。

## 高频坑

1. **statements 改完必须 `npm run reattach`**（见架构一节）。
2. `.gitignore` 里有全局 `*.log`，靠 `!public/ci-logs/*.log` 例外放行 CI 日志——改 ignore 时别弄丢。
3. **rebase 冲突**（CI 机器人提交频繁，push 前常需 `git pull --rebase`）：生成物 `daily.json` 撞车取**超集方**（注意 `--ours` 是 origin 侧、`--theirs` 是自己正重放的提交，曾取反丢过 813 天数据）；statements 与 CI 的 AI 回填撞车取 origin 侧即可；rebase 后必须核验推上去的生成物。
4. 解析器 `unmathjax()`：MathJax v2（frame span）与 v3（`<mjx-container>`）布局要都覆盖，恢复失败曾导致 805 个文件泄漏 `%%ZSMJ%%` 占位符（只能重抓修复）。
5. 前端基建：`postcss.config.mjs` 必须 ESM 导出；新版 lucide-react 无品牌图标（Github 等需内联 SVG）；"Element type is invalid" 报错的真因常是某个导入为 undefined。
6. React 水合：effect 依赖里不要放会变化的 state（cleanup 会掐死 in-flight fetch 导致永挂 loading），用 ref 做真值源（见 `logs-view.jsx` 的 `startedRef` 模式）；图表时间轴锚定最新运行的 `startedAt` 而非 `Date.now()`，保证 SSR/水合一致。历史遗留的 React #418 警告（`renderRich` 嵌套 `<p>`）非回归、无功能影响。
7. 多会话并行开发此仓库：git 操作前先 `git fetch` 对齐，生成物冲突取一侧后重跑 `npm run reattach` 重新生成。
8. 验证方式：`npx next build`（822+ 静态页全过才算过）；UI 改动用 Playwright headless 截图评审；测 AI 翻译链路用本地 mock OpenAI 端点——**mock 必须回显输入中的占位符**（否则 restoreMath 校验失败）且带 CORS 头。
