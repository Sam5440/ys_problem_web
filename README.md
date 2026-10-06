# 🐑 Yawn-Sean 的每日两题

把 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 的每日 Codeforces 两题镜像成开箱即读的网页：完整题面（KaTeX 公式渲染）、提示与中文题解，多渠道中文翻译，另有全量历史归档、按算法分类浏览、社区排行榜，以及完整的 CI 运行日志与 AI 翻译记录看板。

**在线访问**：[ys-problem-web.vercel.app](https://ys-problem-web.vercel.app) · 已收录 800+ 天 / 1600+ 题，每小时自动同步上游

## ✨ 功能特性

- **今日两题**：首页直接呈现最新一期两道题的完整题面（题目描述 / 输入输出格式 / 样例，公式由 KaTeX 渲染），附提示与可折叠题解。
- **「上游已更新」横幅**：站点快照落后于上游时，首页自动提示上游最新题号并附 Codeforces 链接（访客浏览器匿名查上游 README，单次请求、10 分钟本地缓存，已最新或请求失败一律静默）。
- **中文翻译（对照模式）**：默认原文 + 译文逐段对照，译文按用户可拖拽的优先级链取第一个有译文的渠道——默认 **AI (CI翻译) → DeepL → 彩云 → 讯飞 → 有道**，每段结尾始终带来源芯片标注实际生效渠道。
  - 四条免费 MT 渠道由**每位访客的浏览器实时翻译**：按段轮转分发、并发限流、结果缓存进 IndexedDB；DeepL / 有道 / 讯飞经站内同源中继 `/api/mt/[channel]` 解决跨域，彩云直连。公式、行内代码、图片经占位保护原样保留。
  - **AI (CI翻译)**：CI 管道用仓库配置的 OpenAI 兼容端点预生成并存档，访客直接读取、零配置。
  - **AI (用户自定义)**：右上角 ⚙ 设置里填任意 OpenAI 兼容接口，浏览器端逐段实时翻译；Key 只存本机、只发往用户自己的端点。
- **历史归档**：2024-02 起全量上游历史按月分组索引，进入单日页面阅读当日两题。
- **题目分类**：上游按算法/技巧整理的题目一览（DP、贪心、构造……）。
- **排行榜**：同步上游 gh-pages 的社区打卡统计（records），展示连击、活跃天数、解题总数与最近战绩，点击玩家展开 GitHub 风格打卡热力图。
- **CI 日志看板（/logs）**：运行历史时间轴、成功率、抓取 / 翻译产出对比、**AI 翻译 Token 用量统计（含缓存命中拆分）**、单次运行的流水线步骤耗时图；并实时合并 GitHub Actions 最近 100 次运行——空跑 / 被取消的运行以轻量卡片呈现，不产生误导。
- **逐段翻译记录**：每次 CI 运行归档一份独立翻译记录，展开即可逐段查看「原文 → 译文」对照与逐段 Token 消耗。

## 🧱 技术栈

Next.js 15（App Router，全站静态预渲染）+ React 19 + Tailwind CSS v4 + 手写 shadcn 风格组件 + KaTeX + marked。无数据库、无服务端状态：数据由 GitHub Action 定期生成并发布到数据分支，Vercel 构建时组装进静态产物。

## 🗂 仓库与分支模型

本仓库用**代码与数据分离**的多分支模型控制体积：主分支永远只有代码，数据按寿命分级存放在专门分支，Vercel 只从固定的发布分支构建。

| 分支 | 内容 | 保留策略 |
|---|---|---|
| `main` | 站点与脚本代码，**不含任何数据** | 永久（常规开发历史） |
| `data/problems` | 题面 + 翻译（`data/statements/*.json`） | **永久**，并集语义（并发推送不丢文件） |
| `data/misc-<UTC日期>` | 排行榜、CI 日志、上游同步标记 | **滚动 60 天**，每日一个分支，过期由 CI 清理 |
| `deploy` | main 代码 + 全部数据的完整快照 | 单提交**孤立分支**，每次发布强制覆盖，不保留历史 |

```text
上游 Yawn-Sean/Daily_CF_Problems
        │  每小时 CI 轮询（双 SHA 门控，无更新秒级空跑）
        ▼
data/problems               data/misc-YYYY-MM-DD
(题面+翻译·永久·并集)        (排行榜/日志/标记·快照·60 天)
        └─────────┬─────────┘
                  ▼  每次数据更新后组装
    deploy = main 代码 + 数据快照（孤立提交，force-push）
                  ▼
    Vercel 生产构建（Production Branch = deploy）
```

- **main 无数据**：克隆只有几 MB，主分支历史不随数据膨胀；`data/` 与 `public/ci-logs/` 在 `.gitignore` 中，由数据脚本经 git plumbing 写入数据分支。
- **deploy 是纯投影**：永远等于「main 最新代码 + 数据分支最新内容」，无历史、不冲突，可随时用 `npm run data:publish` 重建；内容未变时自动跳过推送，Vercel 不会重复构建。
- 数据分支树内注入了禁用部署的 `vercel.json`，避免数据推送触发垃圾预览部署。

## 🔄 CI 数据管道

### `update-data.yml`（每小时 :12 轮询）

> GitHub 免费公共仓库的 schedule 可靠性很差（实测约 90% 被静默丢弃且不补跑），实际时效依赖手动 `workflow_dispatch` 与运行内自链模式；公共仓库 Actions 用量免费不限量。

**Job 1 `update`（数据同步）**

1. **恢复数据**：检出 main（仅代码），从最新 `data/misc-*` 恢复同步标记、排行榜与日志。
2. **双 SHA 门控**：比对上游 main HEAD（`data/.upstream-sha`）与上游 gh-pages HEAD（`data/.leaderboard-sha`，排行榜 records.js 在 gh-pages 独立更新）。两者都一致 → 秒级空跑结束；仅 gh-pages 变 → 走零依赖的轻量榜单路径。
3. **全量路径**：恢复题面与 daily 快照 → 同步上游 → 补抓最新题面（Playwright 有头 Chrome 过 Cloudflare）→ 修复 ZSMJ 解析污染（有积压时自链下一轮）→ AI 翻译回填（每次预算 60 段，逐段记录 Token 含缓存命中）→ 重新挂载进 `data/daily.json`。
4. **发布**：题面 → `data/problems`（并集语义）；杂项 → 当天 `data/misc-*`；组装 `deploy` 孤立快照强推 → Vercel 自动部署。CI 不向 main 提交任何东西。

**Job 2 `save-log`（日志与翻译记录归档）**

- update 结束后独立下载本次运行完整日志，清洗后存 `public/ci-logs/<日期>-<runId>.log` + 摘要 `.json` + 逐段翻译记录 `.ai.json`，追加进当天 misc 分支并重新发布 deploy，/logs 立即可见。

### `publish-deploy.yml`（代码推送 / 每日兜底 / 手动）

main 有代码推送时约 2 分钟内带着最新数据重建 deploy——**push main 即发布**；同时承担每日清理过期 `data/misc-*` 分支。

## 🚀 部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSam5440%2Fys_problem_web&project-name=ys-problem-web)

1. 点击按钮导入仓库。
2. **把项目的 Production Branch 设为 `deploy`**（Settings → Git → Production Branch）——deploy 分支含全部数据，Vercel 按 `vercel.json` 执行 `node scripts/prepare-build.mjs && next build`。
3. 此后 GitHub Action 每小时把新数据发布到 deploy，Vercel 自动刷新站点，无需任何数据库。
4. 可选：在仓库 Secrets 配置 `AI_BASE_URL` / `AI_API_KEY`（OpenAI 兼容端点）启用 CI 侧 AI 翻译回填；`AI_MODEL`、`AI_TRANSLATE_LIMIT` 写死在 workflow 里，可按需修改。

> main / PR 分支本身不含数据，构建时 `prepare-build.mjs` 会自动从 deploy 分支拉取数据快照（经 codeload 下载 tarball，不依赖 git fetch），预览构建同样开箱可用。

## 💻 本地开发

```bash
npm install
npm run data:pull     # 第一步（必须）：从数据分支恢复 data/ 与 public/ci-logs/
npm run dev           # 开发服务器 http://localhost:3000
npm run build         # prepare-build（数据缺失会自动从 deploy 拉）+ next build

npm run update-data   # 手动全量同步上游（CF_STATEMENTS=0 / TRANSLATE=0 / MAX_DAYS 等开关见脚本头部）
npm run reattach      # 改动 data/statements/ 后重新挂载进 data/daily.json（站点渲染的是后者）
npm run translate     # 手动回填四渠道 MT 译文
node scripts/translate-ai.mjs                  # AI 翻译回填（需 AI_BASE_URL / AI_API_KEY）
node scripts/fetch-statements.mjs --limit N    # 补抓题面（续传式）
node scripts/push-data-branches.mjs --problems --misc --prune   # 推送本地数据到数据分支
npm run data:publish  # 手动重建 deploy 发布分支
```

注意：main 不跟踪任何数据文件——改动题面 / 翻译后，先 `reattach`，再 `push-data-branches.mjs --problems` 推数据分支，最后 `data:publish` 重建 deploy；**不要把数据提交进 main**。

## 🧪 测试

```bash
node --test scripts/tests/               # 分支命名 / 保留期 / 上游 README 解析等纯逻辑单测
bash scripts/tests/e2e-data-branches.sh  # 夹具仓库端到端：建分支 / 并集 / 跨日链 / 清理 / 发布 / 恢复
```

## 📄 免责声明

题目与题解内容来自 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 与 Codeforces，仅供学习交流使用。
