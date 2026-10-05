# Vercel 存储占用削减指南

针对本项目「Deployment Storage > 6GB」的治理方案。**2026-10-05 大部分步骤已执行完毕**，本文保留全部原理与剩余操作，作为后续参考。所有数字为当日实测。

## 背景：钱怎么花的（30 秒）

- 单次部署产物原为 **~214MB**：`/day/[date]` 的 821 个预渲染页（html+rsc+meta）占 ~173MB（81%），leaderboard 页 ~15MB，archive 页 ~5.7MB。
- Vercel Deployment Storage（[官方说明](https://vercel.com/docs/deployment-storage)）为「保持可回滚」的存档：Hobby 默认保留 **30 天**。
- 致命机制（已修复）：`app/layout.jsx` footer 曾把 `generatedAt` 渲染进**每一个页面**，而 `update-data.mjs` 每次 `new Date().toISOString()`（Vercel 构建时 prebuild 会重新生成）→ 每次部署全部 821 页字节级重写，**Vercel 跨部署文件去重完全失效**。『数据更新于…』是纯 UI 文案，不值得付这个代价。
- 项目共 38 个部署 × ~214MB ≈ 8GB 存量（项目随仓库重建于 10/2，仅 3 天就堆出这个量）。

## 已执行 ✅

### 1. 清理存量部署（2026-10-05，API 完成）

- [x] 删除 33/38 个旧部署，保留最新 5 个（当前生产 + 4 个近 20h 回滚点），零失败。
- [x] 手段：`GET /v6/deployments` 列清单 → `DELETE /v13/deployments/{uid}` 逐个删。
- 注意：删除有 **30 天恢复期**（Settings → Security → Recently Deleted），之后永久清除。
- 结果：存量从 ~8GB 回落到 ~1GB 级（等 Usage 页刷新确认曲线）。

### 2. 恢复跨部署去重（footer 时间戳客户端渲染）

- [x] 新建 `components/DataFreshness.jsx`（client 组件）渲染「数据更新于 <date>」，日期来自构建期生成的 `public/build-info.json`（47B）；`app/layout.jsx` 不再引用 `getMeta()`。
- [x] 构建/部署产物不含时间戳：本地构建后实测各页面 `generatedAt` 出现次数为 0。
- [x] 新脚本 `scripts/write-public-data.mjs`：`npm run build`（prebuild 末尾）与 Vercel `buildCommand` 都会执行。
- 依赖数 `getMeta` 的其他页面：无（已 grep 验证）。

### 3. 产物瘦身（~214MB → ~125MB/次，-42%）

- [x] **KaTeX token 化 + 客户端渲染**：`lib/render.js` 不再服务端展开公式，输出烘焙稳定的 `<code class="zs-math" data-display=…>$$tex$$</code>` token（SSR/客户端一致，水合零差异）；新增 `components/KatexRuntime.jsx` —— 挂在 layout 的 MutationObserver，幂等转换所有 token（含访客翻译动态替换的段落、/logs 页），48/48 公式转换成功、0 错误。
  - 附带收益：server bundle 不再含 katex（原 render.js 顶层 import 已移除）；KaTeX JS 之前就因 StatementBody 是 client 组件而已在客户端图里，客户端体积不变。
  - 代价：水合前公式短暂显示原始 `$…$` 文本（约几百 ms），无 JS 访客看到的是可读原始式子。
- [x] **leaderboard/archive 数据外置**：两页改为客户端 `fetch` 构建期导出（`public/leaderboard.json` 300KB、`public/archive.json` 瘦身后 227KB，从 daily.json 生成且附题目标题）。页面 html+rsc 从 15MB/5.7MB → **各 ~21KB**；顺带 archive 行首屏有骨架屏。
- 新增组件：`LeaderboardClient.jsx`、`ArchiveClient.jsx`（页面壳保留 server 端 metadata 与标题）。
- `lib/leaderboard.js` 改为纯函数（`buildLeaderboardRows(data)`），不再静态 import JSON。

### 4. Vercel 构建命令跳过 prebuild

- [x] `vercel.json`: `"buildCommand": "node scripts/write-public-data.mjs && next build"`。数据全由 CI 提交进仓库，构建期再跑 `update-data.mjs` 是冗余且引入不确定性（每次部署刷新时间戳、可能拉到比提交更新的数据）。本地 `npm run build` 行为不变。

## 待执行（唯一剩余步骤，需要 Dashboard 或你的参与）

### 项目级 Deployment Retention

公开 API 没有项目级写入路径（实测 `PATCH /v6~v13/projects/{name}` 均拒绝 `deploymentExpiration` 字段；CLI `--policy` 只是预演不落盘），需在 Dashboard 点击：

- [ ] 项目 **Settings → Security → Deployment Retention Policy**：
  - Production：`3 days`
  - Pre-Production：`1 day`
  - Canceled / Errored：`1 day`
- 理由：当前开发期一天可产生 ~20 个部署，7 天保留也扛不住；3 天 + 例外规则（最近 3 个 Ready 生产部署永不删）已够回滚。
- 备选：Team Settings → Security & Privacy 的团队默认策略（`PATCH /v2/teams/{id}` 的 `defaultExpirationSettings` 可写）——但它影响面不清且会波及其他项目（pdf-toolkit 等），未动。
- 到期删除也有 30 天恢复期，忘记改也不会丢数据。

## 不要做的事

- **不要关构建缓存**（`.next/cache` ~500MB，Vercel 端上限 1GB/项目）——省不了多少，每次构建时间翻倍。
- **不要试图删例外部署**（最近 3 个 Ready 生产部署）——回滚底线。
- **不要用 `.vercelignore` 排除 `data/`** —— daily.json 是构建必需品。
- **不要在 CI 里减少提交频率来治存储** —— 数据提交是核心机制；治本靠 retention + 第三步的去重。

## 预期总账（实测后修订）

| 阶段 | 单次部署新增存储 | 稳态占用 |
|---|---|---|
| 现状（治理前） | ~214MB 全量重写 | 38 部署 ≈ 8GB |
| 已删 33 个旧部署 | — | ~1GB（5×~125MB，含 5 个新部署） |
| 已修复去重（数据提交） | **<1MB**（只重写当日页+榜单+归档） | 增速 ≈ 0 |
| 已瘦身（代码提交） | ~125MB | — |
| + 待做的项目级 Retention | — | **~375–500MB 稳态**（3 个例外 × ~125MB） |

注意：纯代码提交会改共享 chunk 哈希、页面引用跟着变，仍全量重写——无法且无需避免（数据提交才是主力）。

## 译文数据修正（2026-10-05 核实）

多渠道译文**不是**存储大头：全库译文仅 ~400KB、61/814 天有（且 MT 四渠道是访客浏览器实时翻译、不进构建产物）。翻译架构无需为存储做任何改动。

## 验证清单（复跑用）

- [ ] `npx vercel ls` —— 部署数量与删除记录
- [ ] Usage → Deployment Storage，30 天区间对比
- [ ] 部署详情 → Resources → Static Assets —— day/[date] 与 leaderboard 体积
- [ ] 本地 `npx next build` 后 `du -sh .next/server/app` —— 应保持 ~108MB
- [ ] 截图走查：/、/day/2024-02-26（公式渲染）、/leaderboard、/archive、/logs
