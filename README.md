# ys_problem_web

把 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 的每日 Codeforces 两题转换成直观的网页展示：首页直接呈现最新两题的**完整题面**（含样例、KaTeX 公式渲染）、提示与中文题解，另有全量历史归档、按算法分类浏览、社区排行榜，以及完整的 **CI 运行日志与 AI 翻译记录**看板。

## ✨ 功能

- **今日两题**：首页直接展示最新一期两道题的完整题面（题目描述 / 输入输出格式 / 样例，公式由 KaTeX 渲染），并附提示与题解（可折叠）。
- **题面中文翻译（对照模式）**：默认显示原文 + 译文对照，译文每段按用户优先级链取第一个有存档的渠道——默认 **AI (CI翻译) → DeepL → 彩云 → 讯飞 → 有道**，可在设置里拖拽调整；每段译文结尾始终带来源芯片，标注实际生效的渠道（MT 渠道 / AI 内置 / AI 外置）。
- **六条翻译渠道**：
  - 四条免费 MT 渠道（DeepL / 有道 / 彩云 / 讯飞）由**每位访客的浏览器实时翻译**：按段轮转分发到各渠道、并发限流、结果缓存进 IndexedDB；DeepL / 有道 / 讯飞经站内同源中继 `/api/mt/[channel]` 解决浏览器跨域，彩云可直连。数学公式与行内代码经占位保护原样保留。
  - **AI (CI翻译)**：CI 管道用仓库配置的 OpenAI 兼容端点预生成并存档（`sectionsZh.ai`），访客直接读取，无需任何配置。
  - **AI (用户自定义翻译)**：右上角 ⚙ 设置里填任意 OpenAI 兼容接口（Base URL / API Key / 模型，内置 deepseek-v4-flash 与 glm-5.3-flash 预设），浏览器端逐段实时翻译，Key 只存本机、只发往用户自己的接口（HTTPS 站点需填 HTTPS 接口）。
- **历史归档**：全量上游历史（2024-02 起至今 800+ 天）按月分组的每日题目索引，点击进入单日页面。
- **题目分类**：上游仓库按算法/技巧分类的题目一览（DP、贪心、构造……）。
- **排行榜**：同步上游 gh-pages 的社区打卡统计（records），展示每位玩家的当前/最长连击、活跃天数、解题总数与最近一日战绩，点击玩家可展开 GitHub 风格的打卡热力图（近一年 / 全程），支持排序与搜索。
- **CI 日志看板（/logs）**：workflow 每次运行后自动把完整日志落盘提交进仓库（滚动保留 60 天），看板展示运行历史、成功率、流水线时序图、抓取 / 翻译产出对比，以及 **AI 翻译 Token 用量统计**（统计卡 + 按天汇总表 + 单次运行明细）。
- **逐段翻译记录**：每次 CI 运行会生成一份独立的翻译记录（`<runId>.ai.json`），在 /logs 展开任一次运行即可逐段查看「哪一段原文 → 翻成了哪一段译文」的对照、各渠道质量对比与逐段 Token 消耗。
- 自动更新：GitHub Action **每小时轮询**上游，有更新才执行完整管道并提交，Vercel 自动重新部署。全站静态预渲染，无需数据库。

## 🚀 一键部署到 Vercel

点击下面的按钮，Vercel 会自动克隆本仓库并完成部署（零配置）：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSam5440%2Fys_problem_web&project-name=ys-problem-web)

部署完成后即拥有专属域名；此后数据由仓库内的 GitHub Action 自动更新并触发重新部署。可选：在仓库 Secrets 配置 `AI_BASE_URL` / `AI_API_KEY`（OpenAI 兼容端点）即可启用 CI 侧的 AI 翻译回填。

## 💻 本地开发

```bash
npm install
npm run dev            # 开发服务器 http://localhost:3000
npm run build          # 生产构建（prebuild 会先从上游现拉一次数据）
npm run update-data    # 手动同步上游数据到 data/daily.json 与 data/leaderboard.json
npm run reattach       # 改动 data/statements/ 后重新挂载进 data/daily.json（站点渲染的是后者）
npm run translate      # 手动回填四渠道 MT 译文（TRANSLATE=0 可关闭）
node scripts/translate-ai.mjs   # 手动跑 AI 翻译回填（需 AI_BASE_URL / AI_API_KEY 环境变量）
node scripts/fetch-statements.mjs [--limit N]   # 补抓题面（续传式）
```

## 📦 数据管道

`.github/workflows/update-data.yml` **每小时 :12 轮询一次**（避开整点高峰），双 job 结构：

**Job 1 `update`（数据同步）**

1. **上游检查**：比对上游仓库 HEAD 与 `data/.upstream-sha`（上次同步记录），一致则跳过全部重活（约 9 秒空跑），有变化或手动触发才执行完整管道。
2. 同步上游 `daily_problems/**` 与题解到 `data/daily.json`（全量历史，不截断），并从上游 gh-pages 拉取打卡统计写入 `data/leaderboard.json`。
3. **补抓最新题面**（`fetch-statements.mjs --limit 4`）：Codeforces 有 Cloudflare 质询，普通 HTTP 一律 403。方案是 Playwright 驱动真实浏览器引擎，无头 Chromium 被卡住时自动升级为有头真实 Chrome（CI 里跑在 Xvfb 下），礼貌节奏（随机间隔、失败冷却），题面存 `data/statements/<题号>.json` 永久复用。
4. **修复 ZSMJ 污染**（`repair-zsmj.mjs --limit 200`）：重抓早期被旧版 MathJax v3 解析器污染的题面并合并；若仍有积压，运行末尾会**自链触发下一轮**（GitHub 并发组只保留最新排队运行，排队式批量触发会被取消，必须 run 内自链）。
5. **AI 翻译回填**（`translate-ai.mjs`）：按从新到旧给缺 `ai` 渠道的段落调用 OpenAI 兼容端点翻译（每轮预算 `AI_TRANSLATE_LIMIT=60` 段、公式占位保护、连续 5 败熔断、幂等续传），**逐段记录 Token 消耗**（输入/输出），日志末尾输出机器可解析的 `TOKEN-USAGE` 汇总行。
6. 重新挂载 → 提交 `data/` → 推送（rebase 重试防竞争），触发 Vercel 部署。

**Job 2 `save-log`（日志与翻译记录落盘）**

- 下载本次运行的完整日志，清洗后存 `public/ci-logs/<日期>-<runId>.log`，解析出抓取 / 翻译 / Token 摘要存同名 `.json`；再从题面文件构建**逐段「原文 ↔ 译文」翻译记录**存 `<日期>-<runId>.ai.json`。三类文件随仓库提交、滚动保留 60 天，/logs 页面直接读取展示。

> 网页构建时（prebuild）也会直接从上游仓库现拉一次数据，保证每次部署都是最新；上游不可达时自动回退仓库内快照。

## 📄 免责声明

题目与题解内容来自 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 与 Codeforces，仅供学习交流使用。
