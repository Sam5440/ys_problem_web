# ys_problem_web

把 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 的每日 Codeforces 两题转换成直观的网页展示：首页直接呈现最新两题的**完整题面**（含样例、KaTeX 公式渲染）、提示与中文题解，另有历史归档与按算法分类浏览。

## ✨ 功能

- **今日两题**：首页直接展示最新一期两道题的完整题面（题目描述 / 输入输出格式 / 样例，公式由 KaTeX 渲染），并附提示与题解（可折叠）。
- **历史归档**：最近 60 天的每日题目索引，按月分组，点击进入单日页面。
- **题目分类**：上游仓库按算法/技巧分类的题目一览（DP、贪心、构造……）。
- **自动更新**：GitHub Action 每日定时从上游仓库同步数据并提交，Vercel 会自动重新部署。
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
npm run update-data  # 手动同步上游数据到 data/daily.json
```

## 📦 数据管道

- `scripts/update-data.mjs` 通过 GitHub API 发现上游 `daily_problems/**/problems.md` 与题解文件，解析为结构化 JSON，合并写入 `data/daily.json`（保留最近 60 天）。
- 完整题面优先取自 `data/statements/*.json`（人工校对）；对近期未收录题面的题目，脚本会尽力直接抓取 Codeforces（被反爬拦截时自动跳过，页面降级为原题链接 + 提示）。
- `.github/workflows/update-data.yml` 每天 13:20 UTC 运行一次同步，有变化时自动提交并触发 Vercel 部署。

## 📄 免责声明

题目与题解内容来自 [Yawn-Sean/Daily_CF_Problems](https://github.com/Yawn-Sean/Daily_CF_Problems) 与 Codeforces，仅供学习交流使用。
