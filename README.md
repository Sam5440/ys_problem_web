# ys_problem_web

把 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 的每日 Codeforces 两题转换成直观的网页展示：首页直接呈现最新两题的**完整题面**（含样例、KaTeX 公式渲染）、提示与中文题解，另有历史归档与按算法分类浏览。

## ✨ 功能

- **今日两题**：首页直接展示最新一期两道题的完整题面（题目描述 / 输入输出格式 / 样例，公式由 KaTeX 渲染），并附提示与题解（可折叠）。
- **题面中文翻译**：题面默认显示**对照翻译**——原文加译文，译文每段按用户优先级取第一个有存档的渠道（默认 DeepL → 彩云 → 讯飞 → 有道，降级自动发生并在段首标注实际渠道）。**右侧侧边栏**（窄屏为右下角浮动按钮）也可固定单渠道：英文、中文(DeepL)、中文(有道)、中文(彩云)、中文(讯飞)、中文(AI)。前四个渠道的译文由每日管道预生成，按段对齐，数学公式与行内代码原样保留。选择记忆在本地。
- **自定义 AI 翻译**：右上角 ⚙ 设置里可配置任意 OpenAI 兼容接口（Base URL / API Key / 模型，内置 deepseek-v4-flash 与 glm-5.3-flash 两个预设）。「中文(AI)」渠道在浏览器端逐段实时翻译（公式占位保护、并发限 2、结果缓存），API Key 只存在本机浏览器、只发往用户自己填写的接口；HTTPS 部署站点需填 HTTPS 接口地址。设置里还可自定义对照优先级、开关「AI 补缺」（优先级更高的渠道缺存档译文时先试 AI，失败再降级到下一渠道）、以及侧栏显示哪些渠道。
- **历史归档**：最近 60 天的每日题目索引，按月分组，点击进入单日页面。
- **题目分类**：上游仓库按算法/技巧分类的题目一览（DP、贪心、构造……）。
- **排行榜**：同步上游 gh-pages 的社区打卡统计（records），展示每位玩家的当前/最长连击、活跃天数、解题总数与最近一日战绩，点击玩家可展开 GitHub 风格的打卡热力图（近一年 / 全程），支持排序与搜索。
- **自动更新**：GitHub Action 每日定时从上游仓库同步数据（题库 + 排行榜）并提交，Vercel 会自动重新部署。
- 全站静态预渲染，无需任何环境变量或数据库。

## 🚀 一键部署到 Vercel

点击下面的按钮，Vercel 会自动克隆本仓库并完成部署（零配置）：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSam5440%2Fys_problem_web&project-name=ys-problem-web)

部署完成后即拥有专属域名；此后每日数据由仓库内的 GitHub Action 自动更新并触发重新部署。

## 💻 本地开发

```bash
npm install
npm run dev          # 开发服务器 http://localhost:3000
npm run build        # 生产构建（全静态）
npm run update-data  # 手动同步上游数据到 data/daily.json 与 data/leaderboard.json
```

## 📦 数据管道

- `scripts/update-data.mjs` 通过 GitHub API 发现上游 `daily_problems/**/problems.md` 与题解文件，解析为结构化 JSON，合并写入 `data/daily.json`（保留最近 60 天）；同时从上游 **gh-pages 分支**拉取社区打卡统计 `records.js`，解析写入 `data/leaderboard.json`。**网页构建时（prebuild）也会直接从上游仓库现拉一次**，保证每次部署都是最新数据；上游不可达时自动回退到仓库内的快照。
- **完整题面抓取**（`scripts/lib/cf-statement.mjs` + `scripts/fetch-statements.mjs`）：Codeforces 位于 Cloudflare 之后，普通 HTTP 客户端一律 403 "Just a moment..."。方案是 Playwright 驱动真实浏览器引擎自动通过 JS 质询，两阶段自适应——先无头 Chromium（CI 友好），被质询卡住时自动升级为**有头真实 Chrome**（等同真人浏览，CI 里跑在 Xvfb 虚拟显示下）。抓取保持礼貌节奏（随机间隔、失败冷却 4 分钟），题面存入 `data/statements/<题号>.json` 供永久复用。
- **题面中文翻译**（`scripts/lib/translate.mjs` + `scripts/translate-statements.mjs`）：零凭证调用四个网页版翻译通道——DeepL 网页版、有道 webfanyi、彩云小译、讯飞听见（逻辑移植自 [OJBetter](https://github.com/beijixiaohu/OJBetter)，GPL-3.0）。**每平台一个单线程 worker 并行翻译全部段落**（平台内请求间隔 2 秒），共享分段队列：失败重新排队（每段每平台最多重试 3 次、间隔 10 秒）；某段全部平台都失败才存 null（站上标注"⚠ 本段暂无翻译"），任何缺失的（段落, 平台）译文都会被下次运行自动回填。译文按段按渠道存回题面 JSON：`sectionsZh[key][i] = { deepl: …, youdao: … }`。翻译前把 `$$$…$$$` 公式与行内代码替换成占位符，译后校验还原，公式永不进翻译引擎。管道幂等（每日 CI 顺手处理新题面），`npm run translate` 可手动回填，`TRANSLATE=0` 关闭；本地改动 `data/statements/` 后跑 `npm run reattach` 重新挂载进站点实际渲染的 `data/daily.json`。
- 手动回填/补齐：`node scripts/fetch-statements.mjs`（可续传；`--limits-only` 只补时间/内存限制；`--force` 全量重抓）。
- `.github/workflows/update-data.yml` **每天 0 点和 4 点（北京时间）各刷新一次**：同步上游 → 补抓最新未覆盖题面（已抓取的自动跳过，失败不阻塞）→ **并行多平台翻译缺失译文** → 重新挂载 → 提交 `data/`（题面与译文跨日积累）→ 触发 Vercel 部署。

## 📄 免责声明

题目与题解内容来自 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 与 Codeforces，仅供学习交流使用。
