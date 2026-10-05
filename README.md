# ys_problem_web

把 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 的每日 Codeforces 两题转换成直观的网页展示：首页直接呈现最新两题的**完整题面**（含样例、KaTeX 公式渲染）、提示与中文题解，另有全量历史归档、按算法分类浏览、社区排行榜，以及完整的 **CI 运行日志与 AI 翻译记录**看板。

## ✨ 功能

- **今日两题**：首页直接展示最新一期两道题的完整题面（题目描述 / 输入输出格式 / 样例，公式由 KaTeX 渲染），并附提示与题解（可折叠）。
- **题面中文翻译（对照模式）**：默认显示原文 + 译文对照，译文每段按用户优先级链取第一个有存档的渠道——默认 **AI (CI翻译) → DeepL → 彩云 → 讯飞 → 有道**，可在设置里拖拽调整；每段译文结尾始终带来源芯片，标注实际生效的渠道。
- **六条翻译渠道**：
  - 四条免费 MT 渠道（DeepL / 有道 / 彩云 / 讯飞）由**每位访客的浏览器实时翻译**：按段轮转分发到各渠道、并发限流、结果缓存进 IndexedDB；DeepL / 有道 / 讯飞经站内同源中继 `/api/mt/[channel]` 解决浏览器跨域，彩云可直连。数学公式与行内代码经占位保护原样保留。
  - **AI (CI翻译)**：CI 管道用仓库配置的 OpenAI 兼容端点预生成并存档（`sectionsZh.ai`），访客直接读取，无需任何配置。
  - **AI (用户自定义翻译)**：右上角 ⚙ 设置里填任意 OpenAI 兼容接口（Base URL / API Key / 模型），浏览器端逐段实时翻译，Key 只存本机、只发往用户自己的接口。
- **历史归档**：全量上游历史（2024-02 起至今 800+ 天）按月分组的每日题目索引，点击进入单日页面。
- **题目分类**：上游仓库按算法/技巧分类的题目一览（DP、贪心、构造……）。
- **排行榜**：同步上游 gh-pages 的社区打卡统计（records），展示每位玩家的当前/最长连击、活跃天数、解题总数与最近一日战绩，点击玩家可展开 GitHub 风格的打卡热力图。
- **CI 日志看板（/logs）**：workflow 每次运行后自动把完整日志归档进数据分支（滚动保留 60 天），看板展示运行历史、成功率、流水线时序图、抓取 / 翻译产出对比，以及 **AI 翻译 Token 用量统计**（含缓存命中拆分）。
- **逐段翻译记录**：每次 CI 运行生成一份独立翻译记录，在 /logs 展开任一次运行即可逐段查看「哪一段原文 → 翻成了哪一段译文」的对照与逐段 Token 消耗。
- 自动更新：GitHub Action **每小时轮询**上游，有更新才执行完整管道并发布，Vercel 自动重新部署。全站静态预渲染，无需数据库。

## 🗂 仓库与分支模型

本仓库用**代码与数据分离**的多分支模型控制体积：主分支永远只有代码，数据按寿命分级存放在专门分支，Vercel 只从固定的发布分支构建。

| 分支 | 内容 | 保留策略 |
|---|---|---|
| `main` | 站点与脚本代码，**不含任何数据** | 永久（常规开发历史） |
| `data/problems` | 题面 + 翻译（`data/statements/*.json`，各渠道译文内嵌其中） | **永久**，保留完整提交历史 |
| `data/misc-<UTC日期>` | 排行榜、CI 日志、上游同步标记等杂项 | **滚动 60 天**：每天一个新分支（按日期命名），过期分支由 CI 清理 |
| `deploy` | main 代码 + 全部数据的完整快照 | 单提交**孤立分支**，每次发布强制覆盖，不保留旧 Git 记录 |

```text
上游 Yawn-Sean/Daily_CF_Problems
        │  每小时 CI 轮询（双 SHA 门控，无更新 ~9 秒空跑）
        ▼
data/problems            data/misc-YYYY-MM-DD
(题面+翻译·永久)          (排行榜/日志/标记·滚动 60 天)
        └──────────┬────────────┘
                   ▼  每次数据更新后组装
        deploy = main 代码 + 数据快照（孤立提交，force-push）
                   ▼
        Vercel 生产构建（Production Branch = deploy）
```

- **main 无数据**：克隆只有几 MB，主分支历史不再随数据膨胀。`data/` 与 `public/ci-logs/` 在 `.gitignore` 中，由数据脚本经 git plumbing 强制写入数据分支。
- **deploy 是纯投影**：永远等于「main 最新代码 + 数据分支最新内容」，不积累历史、不会冲突，可随时用 `npm run data:publish` 重建；内容未变化时自动跳过推送，Vercel 不会重复构建。
- **滚动清理双保险**：`data/misc-*` 分支按 60 天保留期由 CI 清理（数据更新时 + 每日计划任务）；CI 日志文件本身也按文件名日期前缀滚动 60 天。
- 数据分支自带 `vercel.json` 禁用 `data/*` 的 Vercel 部署，避免数据推送触发垃圾预览部署。

## 📦 CI 数据管道

### `.github/workflows/update-data.yml`（每小时 :12 轮询）

> GitHub 免费仓库的 schedule 极不可靠（实测 ~90% 被静默丢弃），实际更新依赖自链模式与手动 `workflow_dispatch`；公共仓库 Actions 用量免费不限量。

**Job 1 `update`（数据同步）**

1. **恢复数据**：检出 main（仅代码）→ 从最新 `data/misc-*` 恢复同步标记、排行榜与日志。
2. **双 SHA 门控**：比对上游 main HEAD（`data/.upstream-sha`）与上游 gh-pages HEAD（`data/.leaderboard-sha`，社区排行榜在 gh-pages 独立更新）。都一致 → 空跑结束；仅 gh-pages 变 → 走轻量榜单路径。
3. **仅榜单路径**：`sync-leaderboard.mjs`（零依赖，不装 npm 不启浏览器）→ 更新 misc 分支 → 重新发布 deploy。
4. **全量路径**（上游 main 变化或手动触发）：恢复题面与 daily 快照 → 同步上游 `daily_problems/**` 与题解 → **补抓最新题面**（Playwright 有头 Chrome 过 Cloudflare，Xvfb）→ **修复 ZSMJ 污染**（幂等续传，有积压时自链下一轮）→ **AI 翻译回填**（预算 60 段，逐段记录 Token 含缓存命中）→ 重新挂载进 `data/daily.json`。
5. **发布**：题面 → `data/problems`（并集语义，并发推送不丢文件）；杂项 → `data/misc-<今天>`；组装 `deploy` 孤立快照并强推 → Vercel 自动部署。

**Job 2 `save-log`（日志与翻译记录归档）**

- 下载本次运行的完整日志，清洗后存 `public/ci-logs/<日期>-<runId>.log`，解析摘要存 `.json`，再从题面构建**逐段「原文 ↔ 译文」翻译记录**存 `.ai.json`；三类文件追加进当天的 misc 分支并重新发布 deploy，/logs 立即可见。

### `.github/workflows/publish-deploy.yml`（代码推送 / 每日 / 手动）

main 有代码推送时约 2 分钟内重建 deploy（代码改动直达生产）；同时承担每日清理过期 `data/misc-*` 分支的兜底。

## 🚀 部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSam5440%2Fys_problem_web&project-name=ys-problem-web)

1. 点击按钮部署（或手动导入仓库）。
2. **把项目的 Production Branch 设为 `deploy`**（Settings → Git → Production Branch）。deploy 分支含全部数据，Vercel 按 `vercel.json` 执行 `node scripts/prepare-build.mjs && next build`。
3. 此后 GitHub Action 每小时发布新数据到 deploy，Vercel 自动刷新站点；无需任何数据库。
4. 可选：在仓库 Secrets 配置 `AI_BASE_URL` / `AI_API_KEY`（OpenAI 兼容端点）启用 CI 侧 AI 翻译回填。

> main / PR 分支本身不含数据，构建时 `prepare-build.mjs` 会自动从 deploy 分支拉取数据快照，预览构建同样开箱可用。

## 💻 本地开发

```bash
npm install
npm run data:pull     # 第一步：从数据分支恢复 data/ 与 public/ci-logs/（~30MB，必须先做）
npm run dev           # 开发服务器 http://localhost:3000
npm run build         # prepare-build（数据缺失会自动从 deploy 拉）+ next build
npm run update-data   # 手动全量同步上游（CF_STATEMENTS=0 TRANSLATE=0 等开关见脚本头部）
npm run reattach      # 改动 data/statements/ 后重新挂载进 data/daily.json（站点渲染的是后者）
npm run translate     # 手动回填四渠道 MT 译文（TRANSLATE=0 可关闭）
node scripts/translate-ai.mjs            # AI 翻译回填（需 AI_BASE_URL / AI_API_KEY）
node scripts/fetch-statements.mjs --limit N   # 补抓题面（续传式）
node scripts/push-data-branches.mjs --problems --misc --prune   # 手动发布本地数据到数据分支
npm run data:publish  # 手动重建 deploy 发布分支
```

注意：main 不跟踪任何数据文件——改动题面 / 翻译后，用 `push-data-branches.mjs` 推到 `data/problems`，再 `data:publish` 重建 deploy；站点（预渲染）渲染的是 `data/daily.json` 内嵌副本，改 statements 后务必先 `npm run reattach`。

## 🧪 测试

```bash
node --test scripts/tests/               # 分支命名 / 保留期选择等纯逻辑单测
bash scripts/tests/e2e-data-branches.sh  # 夹具仓库端到端：建分支 / 并集 / 跨日链 / 清理 / 发布 / 恢复
```

## 📄 免责声明

题目与题解内容来自 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 与 Codeforces，仅供学习交流使用。
