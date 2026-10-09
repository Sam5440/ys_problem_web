# AGENTS.md

给 AI 编码代理的仓库指南。改动前先读一遍，尤其是「分支模型」和「高频坑」。

## 项目概览

Codeforces 每日两题镜像站（数据来自上游 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems)）：Next.js 15 App Router + Tailwind CSS v4 + 手写 shadcn 风格组件（`components/ui/`）+ KaTeX + marked，**全站静态预渲染**，Vercel 自动部署。数据由 GitHub Action 每小时轮询上游自动更新。

## 分支模型（先读这个）

**main 只有代码，没有任何数据。** 数据按寿命分级存放在专门分支，CI 每次把「main 代码 + 最新数据」组装成 `deploy` 分支供 Vercel 构建：

| 分支 | 内容 | 保留策略 |
|---|---|---|
| `main` | 代码，`data/`、`public/ci-logs/`、`public/compiler/` 均被 gitignore | 永久 |
| `data/problems` | 题面 + 翻译（`data/statements/*.json`） | **永久**，完整历史 |
| `data/misc-<UTC日期>` | 排行榜 / CI 日志 / `.upstream-sha`、`.leaderboard-sha` 标记 | 滚动 60 天，每日清理 |
| `data/runtime` | 浏览器编译器运行时二进制（`public/compiler/*`，约 150MB） | **永久**，孤立快照 force-push |
| `deploy` | main 代码 + 数据快照（含 `public/compiler/`） | 单提交孤立分支，每次 force-push 覆盖 |

- **本地开发第一步永远是 `npm run data:pull`**（从数据分支恢复数据进工作区）。工作区里的 `data/`、`public/ci-logs/` 是未跟踪文件，属正常状态。
- **deploy 是纯投影**（main 代码 + 数据分支内容），不带历史、不会冲突，`npm run data:publish` 可随时重建；内容未变时脚本自动跳过推送。
- 改了 statements 之后的发布路径：`npm run reattach` → `node scripts/push-data-branches.mjs --problems` → `npm run data:publish`。**不要试图把数据提交进 main**。
- `daily.json` 不入任何长期分支（可由上游 + statements 重导出），CI 每轮从 deploy 恢复上一份作为增量基线。

## 发布准则（main → deploy / 数据分支的同步逻辑）

Vercel 的生产分支是 `deploy`，**直接 push main 不会立即上线**——main 只存代码，真正上线的是 CI 组装的 `deploy` 分支。所有发布路径最终汇入同一条规则：

> **deploy = main 最新代码 + 数据分支最新内容**，由 `scripts/publish-deploy.mjs` 组装成孤立单提交 force-push；树内容没变时自动跳过推送。

### 同步方向总图

```
main（代码）──git push──▶ publish-deploy.yml（Action，自动）──┐
                                                               ├──▶ 组装 deploy ──▶ Vercel 自动部署生产
上游题库 ──update-data.yml（每小时轮询 / 手动 dispatch）──────┤        （孤立提交 force-push）
                                                               │
本地工作区 ──npm run data:publish（手动版，需先 data:pull）───┘

上游 ──update-data.yml──▶ data/daily.json（临时）＋ statements
                            │ push-data-branches
                            ├──▶ data/problems    题面+翻译（并集语义，永久）
                            └──▶ data/misc-<日期> 排行榜/CI日志/SHA标记（纯快照，60天滚动）

本地工作区 ◀──npm run data:pull── 数据分支（只读恢复，不碰远端）
```

### 核心不变式（任何改动都不得破坏）

1. **main 永远没有数据**。`data/`、`public/ci-logs/` 被 gitignore，数据只进数据分支（plumbing 脚本绕过 ignore 强制 add）。在 main 上普通 `git add data` 会把数据带进主分支历史，毁掉瘦身效果——这是本仓库最严重的破坏性操作。
2. **deploy 是纯投影、可随时重放**。它没有历史（单孤立提交）= publish 时刻的 main HEAD 树 + 数据分支内容。所以「主仓库的任何改动，push 到 main 后的下一次 publish 自动带进 deploy」；deploy 被改坏也无需修复，`npm run data:publish` 随时重建。
3. **两条数据分支寿命与语义不同**。`data/problems` 是**并集**（先叠加远端 tip 再快照，防并发丢题面）、永久保留，丢了只能重抓；`data/misc-<UTC日期>` 是**纯快照**（滚动删除必须生效）、保留 60 天（见高频坑 #4，改 `push-data-branches.mjs` 时必须保住这两条）。
4. **Vercel 只部署 deploy**。数据分支树内注入了禁用部署的 `vercel.json`（`data/*` minimatch）；main/PR 分支构建时 `prepare-build.mjs` 自动从 origin/deploy 拉数据快照，属预览性质，不影响生产。

### 场景 SOP：什么改动走哪条路

| 你改了什么 | 发布路径 | 上线方式与说明 |
|---|---|---|
| 代码（页面/组件/样式/脚本/workflow） | `git push origin main` 即可 | push 自动触发 `publish-deploy.yml`：恢复数据 → 清理过期 misc → 重建 deploy → Vercel 约 2 分钟上线。**无需手动 publish** |
| statements（题面/翻译文本） | `npm run reattach` → `node scripts/push-data-branches.mjs --problems` → `npm run data:publish` | 手动三连，顺序不能乱：不 reattach 站点仍渲染旧题面；只推 problems 不 publish 时线上不变 |
| 想立刻拉取上游新题 | `gh workflow run update-data.yml`（或本地 `npm run update-data` + 上一行 statements 三连） | CI 全链路：同步 → 补抓 → AI 翻译 → 推数据分支 → 重建 deploy |
| deploy 被改坏 / 想强制重建 | `npm run data:pull && npm run data:publish` | 本地重建 deploy；内容没变自动跳过推送；缺 daily.json 脚本会守卫报错 |
| 新机器克隆 / 工作区数据丢了 | `npm run data:pull` | 只恢复工作区，不碰任何远端分支；`npm run build` 缺数据时也会自愈拉 deploy 快照 |

### 主仓库操作对各分支的因果清单

- **push main** → 触发 `publish-deploy.yml`：restore-data → prune 过期 misc → 重建 deploy。**只影响 deploy，不写 data/problems、不改 misc 内容**。删掉/改名 main 里的文件，下一次 publish 后 deploy 同步消失。
- **手动 `npm run data:publish`** → 只重建 deploy（要求工作区已有数据，缺了先 `data:pull`）。
- **手动 `node scripts/push-data-branches.mjs --problems`** → 工作区 `data/statements/*.json` 并集叠加进 `data/problems`；`--misc` 纯快照覆盖当天 misc；`--prune` 只删过期 misc 分支。不跑 publish 就不影响线上。
- **CI update job**（每小时轮询 / 手动 dispatch / 自链）→ 唯一自动化写 `data/problems`、`data/misc-*` 并重建 deploy 的路径；save-log job 追加日志进当天 misc 后也会再 publish 一次。
- **本地工作区**的 `data/`、`public/ci-logs/` 永远只是数据分支的投影（未跟踪文件），删了随时 `data:pull` 找回，不影响任何远端。

## 常用命令

```bash
npm run data:pull      # 从数据分支恢复 data/ 与 public/ci-logs/（克隆后第一步）
npm run dev            # 开发服务器
npm run build          # prepare-build（数据缺失自动从 deploy 拉）+ next build
npm run reattach       # 把 data/statements/*.json 重新挂载进 data/daily.json
npm run update-data    # 同步上游（CF_STATEMENTS=0 TRANSLATE=0 等环境变量控制子步骤）
npm run data:publish   # 手动重建 deploy 发布分支（孤立提交，强推）
node scripts/fetch-statements.mjs --limit N   # 补抓题面（续传式）
node scripts/translate-ai.mjs                 # AI 翻译回填（需 AI_BASE_URL/AI_API_KEY；AI_RECENT_DAYS=N 只翻最近 N 个日期，CI 空跑轮次用它对近 3 天缺译段做二次尝试）
node scripts/sync-leaderboard.mjs             # 仅同步排行榜（records.js → data/leaderboard.json，内容无变化不写盘）
node scripts/repair-zsmj.mjs --limit N        # 重抓 ZSMJ 污染题面
node scripts/save-ci-log.mjs                  # 仅在 Actions 内可用（依赖 GITHUB_* env，缺了会跳过）
node scripts/push-data-branches.mjs [--problems] [--misc] [--prune]   # 手动推送数据分支
npm run data:pull:runtime   # 从 data/runtime 分支恢复 public/compiler/（改编译器运行时前先拉）
npm run runtime:push        # public/compiler/ → data/runtime 分支（孤立快照 force-push）
node scripts/tests/e2e-compiler.mjs           # 浏览器编译器 Playwright 全链路（需先 npm run build && npx next start）
npm run test:cp:cpp                           # C++ 竞赛场景严格矩阵（85 例：STL/算法/IO 格式/三标准/错误谱系，Node 直驱 ~2 分钟）
npm run test:cp:py                            # Python 竞赛场景矩阵（36 例：真 Pyodide + 交互 stdin shim 语义锁，首跑下载 ~13MB 到 /tmp）
npm run test:cp:e2e                           # 浏览器竞赛场景 E2E（-std 切换/RE 谱系/交互时序/多行输出/0.29.3 切换）
node --test "scripts/tests/*.test.mjs"       # 分支逻辑单测（Node 25 起目录形式会把目录当模块加载而报错，用 glob）
bash scripts/tests/e2e-data-branches.sh       # 数据分支模型端到端（夹具仓库，不碰 origin）
```

## 架构与数据流

```
上游仓库 ──(update-data.mjs 每小时 CI)──▶ data/daily.json ◀──(reattach-statements.mjs)── data/statements/*.json
                                            │
                                            ▼
                                   Next.js 静态预渲染（app/，构建于 deploy 分支）
```

- **站点渲染的是 `data/daily.json` 内嵌的题面副本，不是 statements/*.json**。任何脚本或手工改动 statements 之后，必须跑 `npm run reattach`，否则预渲染页面仍是旧数据（历史上曾因此误判为构建缓存问题）。
- 路由：`/`（今日两题）、`/archive`（全量历史归档）、`/categories`、`/leaderboard`、`/day/[date]`、`/logs`（CI 日志看板）、`/logs/ai-demo`（翻译明细演示页）、`/api/mt/[channel]`（浏览器 MT 跨域中继）。
- 构建期读取：`data/daily.json`（`lib/data.js` 直接 import）、`data/leaderboard.json`、`public/ci-logs/`、`data/statements/`（ai-demo 页构建期读）。这些只存在于 deploy 分支 / 本地恢复后的工作区。

### 目录地图

| 路径 | 作用 |
|---|---|
| `components/compiler/CompilerDock.jsx` | 题目右侧编译器停靠面板（DayView 内挂载，首页/日页共用）：语言切换、样例对拍/交互运行/编译检查三模式、控制台、收起抽屉；xl 布局靠 `body.compiler-open` 的 globals.css 规则把主内容左移 42rem |
| `components/compiler/CodeEditor.jsx` | Monaco 编辑器封装（next/dynamic 按需加载）：高亮、诊断标记（clang/-fsyntax-only 与 py ast.parse 注入）、静态补全 + Ctrl+Space 触发 clang `-code-completion-at` 动态补全；editor.worker 用相对 node_modules 路径打包（monaco 0.57 exports 不允许裸包名进 new URL） |
| `components/compiler/CompilerSettingsSection.jsx` | 设置弹窗「编译器」区块：运行时下载管理（Cache API + 进度）、默认模板编辑、默认语言/标准/超时偏好、观望中运行时占位 |
| `lib/compiler/runtimes.js` | 运行时清单：Pyodide 版本（默认 314.0.7 = Python 3.14.2）、clang22 文件与尺寸、「观望中」占位（更新的 clang 发行版不适合刷题时留位） |
| `lib/compiler/runtime-cache.js` | Cache API 层（`compiler-runtime-v1`）：流式进度下载、显式 Content-Type 重建 Response（wasm streaming 需要）、删除/记账 |
| `lib/compiler/cpp-client.js` / `py-client.js` | 主线程客户端：worker 生命周期、请求队列、运行看门狗（交互等待输入时暂停计时）、超时=terminate worker（wasm 无法抢占）；py 另有 KeyboardInterrupt 两段式中断（先中断后 2s 宽限终止） |
| `public/compiler-js/cpp-worker.js` | C++ worker：Cache API 优先读 `/compiler/*`（回退同源网络，.gz + DecompressionStream 直取）、exnref 探测降级 noeh 二进制、SAB 交互 stdin |
| `public/compiler-js/bridge.js` | clang 编排层（改编自 cppstudio-io/wasm-clang-runtime，Apache-2.0，血统 binji/wasm-clang）：MemFS 原型补丁实现「预喂 stdin → 耗尽后 SAB 阻塞交互读」（**必须先于 new API() 打补丁**，emscripten 导入表构造即固化）、编译/链接/多样例复用/语法检查/补全 |
| `public/compiler-js/py-worker.js` | Pyodide worker：fetch 包装接 Cache API（离线二次加载零网络）、固定 stdin 首调全量+EOF、交互 stdin SAB、ast.parse lint |
| `public/compiler/` | **gitignore**，`data/runtime` 分支投影：clang22/-noeh、lld22/-noeh、sysroot22.tar（自重建：真身 iostream + 合成 bits/stdc++.h + 8192 节点 memfs）、manifest.json |
| `scripts/build-cpp-runtime.mjs` + `scripts/lib/sysroot-pack.mjs` | 从 wasi-sdk 33 + 上游 release 重建 C++ 运行时到 `public/compiler/`（本地维护任务；上游 sysroot 的 iostream 是教学桩，`cin >> string` 都不可用，必须重建） |
| `scripts/push-runtime-branch.mjs` | `public/compiler/` → `data/runtime` 分支（孤立快照 force-push；树未变跳过） |
| `scripts/tests/e2e-compiler.mjs` | 浏览器编译器 Playwright 全链路（真实 clang/Pyodide，约 3-6 分钟）；`cpp-cp-matrix.mjs`/`py-cp-matrix.mjs` 为 Node 侧竞赛场景严格矩阵（快、可精确断言）；`e2e-compiler-cp.mjs` 为竞赛场景浏览器 E2E；`cpp-runtime-smoke.mjs` 为 Node 侧快速冒烟 |
| `scripts/update-data.mjs` | 同步上游 problems/题解/排行榜 → `data/daily.json`、`data/leaderboard.json`（全量历史，MAX_DAYS 默认 Infinity） |
| `scripts/lib/git-plumbing.mjs` | 数据分支 git 底层操作：临时 index 组树、commit-tree、branchTip（fetch 取 tip）、push 助手 |
| `scripts/lib/data-branches.mjs` | 分支命名（`data/misc-YYYY-MM-DD`）、60 天保留期选择、最新 misc 分支查找 |
| `scripts/restore-data.mjs` | 把数据分支内容恢复进工作区（`--misc`/`--statements`/`--daily` 可组合；`git restore` 只动工作区不动 index） |
| `scripts/push-data-branches.mjs` | 题面→`data/problems`（**并集语义**：先叠加远端 tip 再快照，防并发丢文件）；杂项→当天 misc 分支（**纯快照**：滚动删除必须生效）；`--prune` 清理过期分支 |
| `scripts/publish-deploy.mjs` | 组装 deploy 孤立提交（HEAD 树 + daily/leaderboard/statements/ci-logs）并 force-push；树未变自动跳过 |
| `scripts/prepare-build.mjs` | 构建自愈：数据缺失时从 origin/deploy 拉快照，再跑 write-public-data（vercel.json buildCommand） |
| `scripts/lib/cf-statement.mjs` | CF 题面解析器（Playwright 抓取、unmathjax 还原公式） |
| `scripts/fetch-statements.mjs` | 抓题面：无头 Chromium ↔ 有头 Chrome 自适应过 Cloudflare，Xvfb 下运行 |
| `scripts/lib/translate.mjs` + `scripts/translate-statements.mjs` | 四渠道网页版 MT（DeepL/有道/彩云/讯飞，移植 OJBetter，GPL-3.0） |
| `scripts/translate-ai.mjs` | CI 侧 AI 翻译回填（OpenAI 兼容端点），批前先发 system-only 预热请求把系统提示词前缀落盘成 DeepSeek 硬盘缓存单元（`AI_WARM_CACHE=0` 跳过），逐段记录 Token（含缓存命中 cached）并写入模型展示名 `aiModel`（`AI_MODEL_LABEL`，换模型时与 `AI_MODEL` 一起改），输出 `TOKEN-USAGE` 汇总行（含 warmup 计量） |
| `scripts/lib/leaderboard.mjs` + `scripts/sync-leaderboard.mjs` | 排行榜同步（上游 gh-pages records.js），解析与写盘共用库（解析纯函数在 `lib/records.js`，node/浏览器共用）；轻量脚本供 CI 仅榜单路径用（零依赖） |
| `lib/records.js` | 上游 records.js 纯解析（`parseRecordsJs`/`decodeSkippedDates`/内容签名），node 同步与浏览器实时榜单共用（无 node 内置依赖，`sync-leaderboard.mjs` 从这里 re-export） |
| `scripts/repair-zsmj.mjs` | 重抓被旧解析器 `%%ZSMJ%%` 污染的题面（幂等续传） |
| `scripts/save-ci-log.mjs` | CI 第二个 job：日志 + 摘要 + 翻译记录落盘 `public/ci-logs/` |
| `lib/ai-record.mjs` | 构建逐段 原文↔译文 翻译记录（save-ci-log 与 demo 页共用） |
| `lib/mt-protect.js` | 公式/代码/图片占位保护（node 与浏览器同源复用，占位符 `[M07]` 零填充格式） |
| `components/logs-view.jsx` | /logs 仪表盘（手写 SVG 图表，时间轴锚定最新运行而非 Date.now()） |
| `components/ai-translate-detail.jsx` | 逐段原文↔译文对照视图（/logs 运行卡内嵌 + /logs/ai-demo） |
| `components/LeaderboardClient.jsx` | /leaderboard 客户端：先渲染 `/leaderboard.json` 构建快照，随后**浏览器匿名直拉上游 gh-pages records.js（29KB、CORS 开放）实时覆盖**——hourly CI 轮询被 GitHub 大量丢弃会让榜单滞后数日，快照只作直连失败时的兜底；内容签名相同则不重渲染；sessionStorage 缓存 10 分钟；成功显示「已实时同步」徽章、失败静默 |
| `components/RecentDaysNav.jsx` | 首页「最近 7 天」快速入口：7 张日期卡（日期整卡可点 → /day/[date]，两道题各自直达题面锚点 #CODE），纯服务端组件、构建期取自 daily.json（无客户端 JS） |
| `components/HighlightRuntime.jsx` | 全站代码块语法高亮：highlight.js/lib-common 按需动态加载（页面无代码块不拉 chunk），MutationObserver 后挂载转换（题解手风琴懒挂载/翻译重渲染都覆盖）；`pre.code-block` 的 `data-lang` 小写后按语言高亮、无标签自动检测；暗色 token 配色手写在 globals.css（不引 hljs 主题）。题面 `<pre>` 段在 StatementBody 直出原文不过 markdown（#include 行不被吞），与 fence 块统一为 `pre.code-block > code` |
| `components/UpstreamLatest.jsx` + `lib/upstream-readme.mjs` | 首页「上游已更新」横幅：访客浏览器匿名拉上游 README（单次请求），解析 `## Today's Problem` 表（日期取自题解链接的 `daily_problems/…` 路径），本地快照落后时提示上游最新题号；sessionStorage 缓存 10 分钟，失败/已最新均静默不渲染 |
| `public/ci-logs/` | CI 产物三件套：`<日期>-<runId>.log/.json/.ai.json`，滚动 60 天（存 misc 分支与 deploy） |
| `data/.upstream-sha` | 上次同步的上游 main HEAD，CI 靠它跳过无更新的轮询（存 misc 分支） |
| `data/.leaderboard-sha` | 上次同步的上游 gh-pages HEAD——**排行榜独立于 main 更新，必须单独记 SHA**（见 CI 一节） |

### CI workflow（`.github/workflows/update-data.yml`，每小时 :12）

双 job：
1. **update**：检出 main（仅代码）→ `restore-data --misc` 恢复标记 → `git ls-remote` 比对**两个**上游 SHA——main（`data/.upstream-sha`）与 gh-pages（`data/.leaderboard-sha`，排行榜 records.js 在 gh-pages 独立更新，主分支不动也会变；只比对 main 曾导致排行榜长期不刷新）。两者都一致→秒级空跑结束；仅 gh-pages 变→只跑 `sync-leaderboard.mjs`（零依赖）→ 更新 misc 分支 + 重新发布 deploy；main 变或手动触发→恢复 statements+daily → 全量同步 → 补抓 4 题 → 修复 ZSMJ（`continue-on-error`；若 `repaired>0 && remaining>0` 用 `gh api .../dispatches` **自链下一轮**——GitHub 并发组只保留最新排队运行，预先排队会被取消，必须 run 内自链）→ AI 翻译回填（预算 60 段，`continue-on-error`）→ `push-data-branches --problems --misc --prune` → `publish-deploy`。**非完整运行的每一轮**（空跑/仅榜单）还会执行「近 3 天缺译二次尝试」：`translate-ai.mjs` 带 `AI_RECENT_DAYS=3`（零依赖路径：restore → translate → reattach，无需 npm ci），译到就推 problems + 重发 deploy，且 `retry_changed` 计入 save-log 归档条件（否则 /logs 会把真实数据更新误判成空跑）；完整运行自身已有最新优先的翻译步，不重复跑该步。**CI 不再向 main 提交任何东西。**
2. **save-log**（`needs: update`，`if: !cancelled()`）：job 日志只有完成后才能下载，所以必须独立 job。写 `.log`（清洗 + 400KB 留尾）+ `.json`（摘要含 `tokenUsage`/`tokenSegments`/`leaderboard`）+ `.ai.json`（逐段翻译记录，需要 statements 所以先 restore）→ 追加进当天 misc 分支 → 重新发布 deploy。仅榜单变更的运行也归档（否则 /logs 会把有数据更新的运行误判成空跑）。

另有 `.github/workflows/publish-deploy.yml`：main 代码推送 → 恢复数据 → 清理过期 misc 分支 → 重建 deploy（代码改动约 2 分钟直达生产）；每日 cron 兜底清理。

**GitHub schedule 可靠性极差**：免费公共仓库优先级最低，实测每小时 cron 约 90% 被静默丢弃且不补跑。可靠性依赖手动 `workflow_dispatch` 或自链模式，不要假设定时任务必然执行。公共仓库 Actions 用量免费不限量。

**Vercel**：Production Branch = `deploy`（项目设置）。数据分支树内注入了禁用部署的 `vercel.json`（`data/*` minimatch），别丢；main/PR 分支构建时 `prepare-build.mjs` 自动从 deploy 拉数据。

## 翻译体系

- 数据模型：`sectionsZh[key][i] = { deepl, youdao, caiyun, iflyrec, ai }`（对象=多渠道；旧版单字符串视为 `legacy`）。标题在 `titleZh`，结构相同。`ai` 译文旁可带元数据键 `aiModel`（该段所用模型的展示名，由 `translate-ai.mjs` 从 `AI_MODEL_LABEL` 写入、缺省回退请求模型名；无此键的旧段按常量 `GLM 5.3 Flash` 展示，见 `lib/ai-model.js`）。**遍历条目键必须按渠道白名单过滤，别把 `aiModel` 当渠道**（参照 `StatementBody.jsx` 的 `mergedChannels` 与 `zh-store.js` 的 `archivedChannels`）。
- 显示优先级链 `DEFAULT_PRIORITY = ['ai', 'deepl', 'caiyun', 'iflyrec', 'youdao']`（`components/settings.jsx`），用户可拖拽调整；每段译文结尾**始终**注入来源芯片（必须注进 `renderRich` 输出的最后一个 `<p>` 内部，外包 `<p>` 会因非法嵌套被丢弃）。
- 渠道分三类：MT 四渠道由**访客浏览器**实时翻译（`lib/zh-store.js` 轮转分发 + IndexedDB 缓存；DeepL/有道/讯飞走 `/api/mt/[channel]` 同源中继，彩云直连）；`ai`=CI 存档（侧栏「AI (CI翻译)」，无需配置）；`ai_custom`=用户自配端点实时翻译。
- **CI runner 的出口 IP 被四家 MT 服务风控，CI 端 MT 几乎全灭**——缺译文只靠 AI 渠道回填或访客浏览器端翻译，不要试图在 CI 里修 MT。
- 翻译前必须过 `lib/mt-protect.js` 占位保护 `$$$…$$$` 公式、行内代码、图片 markdown、裸 URL；AI 响应要做占位还原校验（`restoreMath` 返回空即判失败）。

## Token 与翻译记录

- `translate-ai.mjs` 每段日志：`✓ key[i]: 译文… [tokens in=X out=Y cached=Z]`；结束打印 `TOKEN-USAGE {model,modelLabel,ok,fail,in,out,cached,segments[],totalTokens,warmup}` 单行 JSON。cached 取自 `usage.prompt_cache_hit_tokens`（DeepSeek）或 `prompt_tokens_details.cached_tokens`（OpenAI 兼容），是输入的子集、按更低的缓存价计费；旧日志无 cached，前端一律按 0/「—」兜底。`modelLabel` 与逐段写入的 `aiModel` 同源（`AI_MODEL_LABEL` env，缺省回退 `AI_MODEL`），/logs 运行卡据此标注本次运行所用模型。`warmup` 字段单独计量批前缓存预热探针（mode/in/out/cached），不混入逐段统计。预热原理（DeepSeek 缓存按前缀完整匹配、自动落盘）：system-only 请求让「用户输入结束」边界正好落在系统提示词末尾、将其落盘成缓存单元，之后所有请求共享该字节级不变的前缀即可命中——不要在 system 前插入变化内容、不要并行请求（会破坏前缀匹配）。
- `save-ci-log.mjs` 解析进摘要 `summary.tokenUsage` + `summary.tokenSegments`（`summarize` 已导出可单测；env 检查在 `main()` 内而非模块顶层，避免 import 即退出）。另解析排行榜同步结果行 `LEADERBOARD-SYNC {changed,players,currentDate}` 进 `summary.leaderboard`（/logs 运行卡的「排行榜更新」徽章数据源）。
- `.ai.json` 翻译记录：`{ runId, startedAt, tokenUsage, tokensBySeg: {"<code>:<seg>[i]": {in,out,cached}}, problems: [{code,title,segs:[{key,i,en,zh}],aiCount}] }`。构建自当时的 statements 快照（ai 段即该次运行写入的译文）。
- /logs 相关约定：`app/logs/page.jsx` 与 `app/logs/ai-demo/page.jsx` 的 `loadRuns()` **必须排除 `.ai.json`**（只列 `.json` 摘要），运行卡展开时才懒加载对应 `.ai.json`。
- /logs 时间轴在浏览器端实时合并 GitHub API 匿名拉取的最近 100 次 workflow 运行（`components/logs-view.jsx`，`NEXT_PUBLIC_GH_REPO` 可覆盖仓库）：有仓库存档的以存档为准（按 runId 去重）；空跑/被取消/存档未同步的运行显示「未发生数据提交」等轻量卡片（success 且全程 <5 分钟判为空跑，完整运行 ≥10 分钟）。产出类图表只用有存档的运行，避免被空跑零值刷屏。

## 浏览器编译器（题目右侧停靠面板）

访客浏览器内的 C++/Python 刷题环境：Monaco 编辑器（高亮/诊断/补全）+ WASM 运行时，支持样例对拍、交互 stdin、语法检查，全部计算在用户浏览器完成（不耗服务器）。入口：`DayView` 挂 `CompilerDock`，设置弹窗管运行时下载与模板/偏好。

- **运行时选型**：C++ = clang 22.1 + wasi-sdk 33 sysroot（[cppstudio-io/wasm-clang-runtime](https://github.com/cppstudio-io/wasm-clang-runtime) v0.1.0，Apache-2.0，血统 binji/wasm-clang），C++17/20/23；Python = Pyodide（默认 314.0.7 = CPython 3.14.2，备选 0.29.3）。更新的方案（clang 23 freestanding 发行版、CheerpX）不满足刷题需求，在 `lib/compiler/runtimes.js` 的 `PLACEHOLDERS` 留位说明。
- **发布路径**：`public/compiler/`（约 150MB 二进制）被 gitignore，走 `data/runtime` 永久分支（孤立快照 force-push）；CI 所有 restore-data 均带 `--runtime` 把它注入 deploy，与站点同源。**改动上线顺序**：`npm run runtime:push`（若运行时变了）→ `git push origin main`（触发 publish-deploy 重组 deploy）。新克隆想本地跑编译器先 `npm run data:pull:runtime`。
- **重建运行时**（仅当换 clang/wasi-sdk 版本）：`node scripts/build-cpp-runtime.mjs`，参数见脚本头注释（需下载上游 release + wasi-sdk 33）。上游 sysroot 的 `<iostream>` 是教学桩（`cin >> string` 都不可用），脚本从 wasi-sdk 全量重建并合成 `bits/stdc++.h`（`BITS_BLOCKLIST` 排除 wasi 无 EH/信号对应的头）。
- **交互 stdin**：SharedArrayBuffer + `Atomics.wait`（worker 内阻塞读、主线程喂入），需要跨域隔离——`next.config.mjs` 全站注入 COOP `same-origin` + COEP `credentialless`；`crossOriginIsolated` 为 false 时自动降级为仅固定输入（禁交互模式）。固定 stdin 无需 SAB。
- **worker 消息路由约定**：所有从 worker 主动冒出的消息（log/need-input/进度）**必须带当前请求 id**（cpp-worker 用 `currentId` 变量在 dispatch 时补上），否则 cpp-client 按 `pending.get(msg.id)` 路由时静默丢弃——历史上交互输入框因此永远不出现。日志按请求路由到该请求的 onLog（避免上一个请求的 onLog 持续接收后续日志/ANSI 灌屏；worker 侧同时剥 ANSI 码）。
- **`-std` 必须贯穿全链路**：shared.js 的 `api.compile` 收 `extraArgs`，bridge 的 `compileLinkRunResult`/`runCases` 与 `syntaxCheck`/`codeComplete` 一样接收 `std` 并转成 `-std=` 参数，cpp-worker 从消息里透传。漏传时运行按 clang `-cc1` 默认 gnu++17 编译，与检查所用的设置标准分裂（表现为「检查通过、运行报错」）。
- **trap 输出清理**：程序 trap（assert/abort/除零/栈溢出）时 JS 侧会在程序输出后追加 `Error: …` 与 RuntimeError 堆栈——bridge 的 `cleanStdout` 从第一个 `Error: ` 行整块截掉（切片可能以 `Error: ` 开头，正则要匹配行首），否则内部 JS 堆栈会被当程序输出进 UI/判题。
- **样例 verdict 映射的展开顺序**：`{ index, ...j, verdict: re ? 'RE' : j.verdict }` —— `...j` 必须在 `verdict` **之前**，写反时 `judgeCase` 的 WA 会把 trap/退出码推出的 RE 覆盖回去（C++ 与 Python 两条路径都曾中招，表现为「明明 trap 了 UI 却判 WA」）。
- **触发运行期除零的可靠写法**：`volatile int vz = 0; int zero = vz;`（volatile load 的值优化器不可假设）——`volatile x*0` 乘法与 `asm volatile("" : "+r")` 屏障都会被 clang -O2 折叠掉，不要用来防折叠。
- **Pyodide stdout/stdin 语义**（多轮都曾因此出产品 bug）：① `setStdout({batched})` 回调在换行/flush 时触发但**文本不含换行符**，转发时必须补 `\n`，否则多行输出全部粘连；② 非 raw `setStdin` 回调是**记录式**语义——单条记录最多被 CPython 按 8192 字节分块消费，>8KB 的行被静默截断（无界 `read()` 也只消费一次回调）。两条 stdin 路径都不走 setStdin 喂业务数据，而是向解释器注入**真实字节流**替换 `sys.stdin`：固定 stdin 用 `io.TextIOWrapper(io.BytesIO(...))`（JSON 双重编码传参）；SAB 交互用自定义 `io.RawIOBase`，`readinto` 逐记录从 SAB 拉。交互 shim 三个硬约束（违背即在浏览器死锁/截断，Node 里可能侥幸通过——CPython 分块尺寸随环境不同）：**缓冲非空时绝不拉新记录**（readline 按块读 >8KB 的行要跨多次 readinto 拼接，缓冲有剩就拉下一条会阻塞在还没输入的下一行上）；记录是行且不含换行符，包装时补 `\n`、EOF 记录不补；类体内引用 JS 注入的回调**不能用双下划线名**（Python 名修饰会改写成 `_类名__xxx` 导致 NameError）。
- **C++ 运行时行为谱系**（严格矩阵实测钉死，勿凭直觉改）：异常编译期禁用（`cannot use 'try' with exceptions disabled`，noeh 头文件栈，刷题代码别用 try/throw）；整数除零按 WASM 规范 trap（`divide by zero`）；`abort()`/assert 走 `llvm.trap`→`unreachable`；默认链接栈 1MB，深递归要防 -O2 尾递归消除（volatile 垫帧可测真溢出）；`__int128` 加减乘可靠；clang `-cc1` 默认标准是 gnu++17（`__cplusplus` 201703L）。矩阵：`npm run test:cp:cpp`。
- **Python 侧**：异常完整可用（与 C++ 相反）；`sys.exit(n)` 以 success=false + SystemExit traceback 呈现；lint（ast.parse）诊断消息随 CPython 版本变化（3.14 报 `invalid syntax` 而非 `expected ':'`），lint 断言要跟着版本走。矩阵：`npm run test:cp:py`。
- **超时语义**：wasm 无法被抢占，超时 = terminate 整个 worker（下次运行重新初始化，clang 重载约 10 秒）；Python 先 KeyboardInterrupt（SAB 中断标志）2 秒宽限后才 terminate。交互模式等待用户输入时看门狗暂停计时。
- **缓存**：设置页下载写入 Cache API（`compiler-runtime-v1`，显式 Content-Type 重建 Response，否则 wasm streaming 解析失败）；worker 侧 Cache 优先、回退同源 `/compiler/*`（带 `.gz` + DecompressionStream 首试）。`hasRuntime` 对同源未缓存的运行时做 HEAD 探测（deploy 已带运行时则免下载），跨源必须已缓存。
- **本站对 vendored shared.js 的约定**：`cpp-worker.js` 用正则把 IIFE 的 `return API;` 尾句 patch 成 `return { API, MemFS };` 取出 MemFS 类（顶层作用域本无 MemFS 标识符；外层取回 `return API` 即对子），并给 `MemFS.prototype` 打 stdin 补丁——**必须先于 `new API()`**（emscripten 导入表构造即 bind 固化）。上游改版导致断言报「shared.js 结构变化」时同步这里的正则。
- **Python worker 是 module worker**（`py-client.js` `new Worker(url, { type: 'module' })`）：Pyodide 314 线（Python 3.14）在 classic worker 里直接抛 "Classic web workers are not supported"；py-worker 无 importScripts，两种作用域通吃。C++ 的 cpp-worker 必须保持 classic（依赖 importScripts 挂 bridge.js）。
- **Monaco 0.57**：exports map 把裸子路径全映射进 `esm/vs/*.js`——editor.worker 只能用相对 node_modules 路径进 `new URL`，且勿显式引 `min/vs/editor.main.css`（ESM 构建内联 css import）。**补全架构**：数据在 `lib/compiler/completions.js`（竞赛向**裸名**静态表 + 签名 + 中文文档，node/浏览器同源可单测；首版带 `std::` 前缀，`using namespace std;` 下打 co 无任何匹配——静态表必须存裸名），`CodeEditor.jsx` 做 Monaco 适配：打字即弹静态表；`(`/`,` 出签名提示（参数高亮 + 说明）；悬停出原型文档；`#include <`/`"` 出头文件表；clang `-code-completion-at` 分层接入——Ctrl+Space 手动走 await（keydown 打标手动触发），成员触发字符那一下静态表立即返回 + clang 后台跑进缓存（key=光标前全文，序号防竞态），后续成员上下文击键按前缀命中合并，**不逐键发起 clang**（全量编译秒级），后台完成后不刷新已开 widget（Monaco 0.57 无可靠公开机制，hide+triggerSuggest 互相踩）。坑：① `quickSuggestions` 默认 `offWhenInlineCompletions`（实测打字母不弹），必须显式 `{ other: 'on' }`；② `model.findMatches` 第 6 参 `captureMatches` 必须 true——false 时 `FindMatch.matches` 是 null，取 `[0]` 即抛且异常被 Monaco 吞掉（表现为补全列表恒空）；③ signature help 的 DOM 类名是 `.parameter-hints-widget`（不是 signature-help-widget）；④ 成员上下文判断（`isCppMemberAccess`）必须**先剥光标前正在打的部分词**（`v.pu` 仍是成员上下文），只看紧邻字符会在 `v.p` 处退回普通表、成员候选消失；`.` 前词元须字母/下划线开头（浮点 `1.5` 不弹成员）；⑤ E2E 断言补全必须真实键盘——`executeEdits`/`setValue` 程序化编辑不触发 suggest，且 `v.` 后候选按字母序排，断言要续打部分词过滤（`v.pu`→push_back）而不是指望目标项在可视区。

## Secrets 与环境变量

- 仓库 Secrets：`AI_BASE_URL`、`AI_API_KEY`（OpenAI 兼容端点，CI AI 翻译用）；`AI_MODEL`（请求参数）、`AI_MODEL_LABEL`（写入每段 `aiModel` 的模型展示名，换模型时两个一起改）、`AI_TRANSLATE_LIMIT` 写死在 workflow 里。设置方法：`gh secret set 名字 < 本地文件`，避免密钥进会话记录。
- 脚本开关：`CF_STATEMENTS=0`（跳过挂载题面）、`TRANSLATE=0`（跳过 MT）、`MAX_DAYS`（历史保留天数，默认无限）、`CF_START_MODE=chrome-headful`。
- 数据脚本身份：`DATA_BOT_NAME`/`DATA_BOT_EMAIL` 可覆盖提交者，默认 CI 里是 github-actions[bot]、本地是 git config。

## 高频坑

1. **克隆后 main 里没有数据**——先 `npm run data:pull`，再 dev/build。`data/`、`public/ci-logs/` 是 gitignore 的，工作区里出现它们属正常。
2. **statements 改完必须 `npm run reattach`**（见架构一节）；要发布则再 `push-data-branches --problems` + `data:publish`。
3. **不要把数据提交进 main**：数据分支推送由 plumbing 强制 add（绕过 ignore），但普通 `git add data` 在 main 上会真的把数据带进主分支历史，毁掉瘦身效果。
4. `push-data-branches` 的语义差异：`--problems` 是并集（远端文件先叠加，防并发丢题面），`--misc` 是纯快照（60 天滚动删除必须生效）——改任何一个都要保住这两条不变式。
5. 解析器 `unmathjax()`：MathJax v2（frame span）与 v3（`<mjx-container>`）布局要都覆盖，恢复失败曾导致 805 个文件泄漏 `%%ZSMJ%%` 占位符（只能重抓修复）。
6. 前端基建：`postcss.config.mjs` 必须 ESM 导出；新版 lucide-react 无品牌图标（Github 等需内联 SVG）；"Element type is invalid" 报错的真因常是某个导入为 undefined。
7. React 水合：effect 依赖里不要放会变化的 state（cleanup 会掐死 in-flight fetch 导致永挂 loading），用 ref 做真值源（见 `logs-view.jsx` 的 `startedRef` 模式）；图表时间轴锚定最新运行的 `startedAt` 而非 `Date.now()`，保证 SSR/水合一致。历史遗留的 React #418 警告（`renderRich` 嵌套 `<p>`）非回归、无功能影响。
8. 多会话并行开发此仓库：git 操作前先 `git fetch` 对齐；数据分支推送撞车时脚本会自动叠加远端重试，deploy 无历史永不冲突。
9. 验证方式：`npm run build`（822+ 静态页全过才算过，数据缺失会自动从 deploy 拉）；UI 改动用 Playwright headless 截图评审；测 AI 翻译链路用本地 mock OpenAI 端点——**mock 必须回显输入中的占位符**（否则 restoreMath 校验失败）且带 CORS 头；数据分支模型改动跑 `bash scripts/tests/e2e-data-branches.sh`。
10. 编译器 worker 的经典脚本边界：`cpp-worker.js` 是 classic worker，bridge.js 靠 `importScripts` 挂载（漏写时首个症状是 `self.CPBridge` undefined）；`public/compiler-js/*` 不进 webpack，改动即时生效但语法错误只会在运行时爆——改完跑 `node --check` + `e2e-compiler.mjs`。
11. memfs（wasi 版，非 emscripten）两个硬约束：`addFile` 不覆盖同名节点（每请求用唯一文件名 `m/c/k/s+counter`）；`GetFileNodeAddress` 对目录节点必须静默返回 0（vendored memfs.c 已补丁，重建运行时时勿丢）。
12. E2E 定位编译器面板用 `aside[aria-label="编译器面板"]` 与动作按钮 `aria-label="运行程序"/"检查程序"`——按可见文本「运行」定位会撞上「交互运行」页签（DOM 顺序页签在前）；裸 `locator('aside')` 会命中语言侧栏（strict mode 双元素报错）。`translate-x-full` 的收起面板对 Playwright 仍是「可见」（有包围盒），开合判断以 `aria-hidden` 为准。
13. E2E 断言程序输出时锚定 `aside details` 里的「实际输出」或 `aside pre` 控制台，别用 `aside` 全文——全文会匹配到 Monaco 里的程序源码（曾把「Classic web workers are not supported」的失败运行误判成通过）。
