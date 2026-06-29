<h1 align="center">Understand Anything · fanyb 中文优先版</h1>
<p align="center">
  <strong>将任意代码库、知识库或文档转化为可探索、可搜索、可对话的交互式知识图谱</strong>
  <br />
  <em>本 fork 默认中文输出，并新增 <code>/understand-link</code> 跨服务（多仓库）关联能力。</em>
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="README.zh-CN.md">简体中文（上游）</a> | <a href="readme-fanyb.zh-CN.md">简体中文 · fanyb 版</a>
</p>

<p align="center">
  <a href="#-快速开始"><img src="https://img.shields.io/badge/快速开始-blue" alt="Quick Start" /></a>
  <a href="https://github.com/fanyb/Understand-Anything/blob/main/LICENSE"><img src="https://img.shields.io/badge/许可证-MIT-yellow" alt="License: MIT" /></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude_Code-8A2BE2" alt="Claude Code" /></a>
</p>

<p align="center">
  <img src="../assets/hero.png" alt="Understand Anything — 将任何代码库转换为交互式知识图谱" width="800" />
</p>

> **关于本版本**
> 这是 [fanyb/Understand-Anything](https://github.com/fanyb/Understand-Anything) —— 一个**中文优先**的 fork，相对上游有两点定制：
> 1. **文档里的命令默认带 `--language zh`**，照着用即得中文输出（节点描述 + Dashboard UI + 导览）。
> 2. **新增 `/understand-link` 技能**：把多个已 `/understand` 过的服务（多仓库）关联成一张系统级图，识别跨服务的 Dubbo / HTTP / MQ 调用与业务域归属。
>
> 原作版权归 [Egonex](https://github.com/Egonex-AI) 与 [Lum1104](https://github.com/Lum1104)，遵循 MIT。本 fork 仅做中文化与扩展。

---

**当你刚加入一个新团队，面对 20 万行代码，你从哪里开始？**

Understand Anything 是一个 [Claude Code Plugin](https://code.claude.com/docs/en/plugins-reference#plugins-reference)，通过多智能体（multi-agent）架构分析你的项目，构建包含文件、函数、类以及依赖关系的知识图谱，并提供一个可视化交互界面，帮助你理解整个系统。不再"盲读代码"，而是从全局视角理解系统结构。

> **目标不是用代码库的复杂程度来惊艳你 —— 而是默默告诉你每一块是怎么拼在一起的。**

---

## ✨ 核心功能

### 探索代码结构图

将你的代码库以交互式知识图谱的形式呈现——每个文件、函数和类都是可点击、可搜索、可探索的节点。选择任意节点即可查看通俗易懂的摘要、依赖关系和引导式学习路径。

### 理解业务逻辑

切换到领域视图，查看代码如何映射到真实的业务流程——以水平图的形式展示领域、流程和步骤。

### 关联多个服务（跨仓库）· fanyb 新增

`/understand-link` 把 **N 个已经各自 `/understand` + `/understand-domain` 过的服务**联邦成一张系统级图 `system-graph.json`：服务与业务域是节点，**跨服务的 Dubbo / HTTP / MQ 调用 + 业务流**是边，每条跨服务边都带回指各服务子图的稳定 `(graphRef, nodeId)` 键，便于下钻。主体确定性（注解 / 类型名 / topic 字符串匹配），可选 `--llm-residual` 用一轮小成本 LLM 兜模糊残差。详见 `understand-anything-plugin/skills/understand-link/DESIGN.md`。

### 分析知识库

将 `/understand-knowledge` 指向一个 [Karpathy 模式的 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)，即可获得带有社区聚类的力导向知识图谱。

---

## 🚀 快速开始

### 1. 安装插件（Claude Code）

```bash
/plugin marketplace add fanyb/Understand-Anything
/plugin install understand-anything@understand-anything
```

> 若你之前添加过上游那个同名 market，先 `/plugin marketplace update understand-anything` 刷新，再安装本 fork 版本。
> **使用本地模型？** 可将平台指向本地模型提供方（例如 [Ollama](https://docs.ollama.com/integrations)），按其集成指南更改模型提供方。

### 2. 分析你的代码库（默认中文）

```bash
/understand --language zh
```

多智能体架构会扫描项目、提取函数 / 类 / 依赖，构建知识图谱保存至 `.understand-anything/knowledge-graph.json`。`--language zh` 会让节点摘要、Dashboard UI、导览说明全部生成中文，并把偏好写入 `.understand-anything/config.json`，后续增量更新自动沿用。

> **关于 Token 消耗的提醒：** 首次运行 `/understand` 会分析整个代码库，在大型项目上可能消耗大量 token。建议在有 token 套餐 / 订阅的情况下运行，或在初始化时使用本地模型。后续运行默认增量——只重新分析变更过的文件——消耗大幅减少。

> 支持的语言：`en`、`zh`、`zh-TW`、`ja`、`ko`、`ru`。本 fork 文档统一以 `--language zh` 为示例；首次带上后会被记到 `config.json`，之后即使不再显式传也保持中文。

### 3. 打开数据看板

```bash
/understand-dashboard
```

打开交互式网页数据看板，代码库以图表形式呈现 —— 按架构层级颜色编码，支持搜索和点击。选择任意节点即可查看其代码、关系以及简明易懂的解释。

### 4. 深度使用

```bash
# 询问任意代码库的问题
/understand-chat 支付流程是怎么走的？

# 分析当前修改的影响
/understand-diff

# 深入理解某个文件
/understand-explain src/auth/login.ts

# 为新团队成员生成指南
/understand-onboard

# 提取业务领域知识（领域、流程、步骤）
/understand-domain --language zh

# 关联多个服务为系统级图（先对每个服务跑过 /understand + /understand-domain）
/understand-link                         # 无 manifest 时自动起草草稿并停下让你确认
/understand-link --llm-residual          # 额外开 LLM 兜模糊残差
/understand-link ./my.manifest.json --changed   # 指定 manifest + 增量

# 分析 Karpathy 模式的 LLM Wiki 知识库
/understand-knowledge ~/path/to/wiki --language zh

# 直接重跑即可 —— 默认增量更新，只分析变更的文件
/understand --language zh

# 安装 post-commit 钩子，每次提交自动增量更新
/understand --auto-update --language zh

# 大型 monorepo？把分析范围限定到某个子目录
/understand src/frontend --language zh
```

#### `/understand-link` 用法速记

1. **前置**：每个服务先各自跑过 `/understand --language zh` 与 `/understand-domain --language zh`（该技能只关联现成子图，不重新分析）。
2. **拿到 manifest**（二选一）：
   - **自动生成（推荐）**：直接在几个仓库的父目录输 `/understand-link`。**找不到 manifest 时它会自动扫描当前目录（递归限深 4），把所有已分析的服务（带 `.understand-anything/knowledge-graph.json` 的目录）起草成一份 `understand-link.manifest.json` 草稿，然后停下来让你确认**——`serviceId / repo / root / graphRef / domainRef` 已自动填好，缺 `domain-graph.json` 的服务会被点名（去补 `/understand-domain`）。
   - **手写**：照 `understand-anything-plugin/skills/understand-link/manifest.example.json` 改。
3. **补齐草稿里推断不出的字段并确认**：HTTP 网关前缀（`http.basePath` / `http.gatewayPrefix`）、fe 的 `http.hostMap`、MQ 的 `mq.topics`（真实 topic 值源码里没有，需手填）——这些自动生成时留空，确认前务必填好。改完保存，再让它继续后续阶段。
4. **运行**：在 manifest 所在目录输 `/understand-link`。产物在 `.understand-link/system-graph.json`（系统级图）与 `.understand-link/validation-report.json`（含 unresolved / 环 / 孤儿服务）。
5. **registry 后端**：manifest 里 `registry.backend` 选 `json`（默认，可 git diff）或 `sqlite`（`node:sqlite`，便于规模化 / SQL 查询），两者跨服务边一致。

---

## 🌐 多平台支持

本 fork 同样可在多个 AI 编码平台运行。一行命令安装时，**务必用 `UA_REPO_URL` 指向本 fork**，否则脚本会从上游克隆（拿不到 `/understand-link`）：

**macOS / Linux：**
```bash
curl -fsSL https://raw.githubusercontent.com/fanyb/Understand-Anything/main/install.sh \
  | UA_REPO_URL=https://github.com/fanyb/Understand-Anything.git bash
# 直接指定平台名跳过交互：在末尾加 -s <platform>，例如 ... bash -s codex
```

**Windows（PowerShell）：**
```powershell
$env:UA_REPO_URL = 'https://github.com/fanyb/Understand-Anything.git'
iwr -useb https://raw.githubusercontent.com/fanyb/Understand-Anything/main/install.ps1 | iex
```

安装脚本会把仓库克隆到 `~/.understand-anything/repo` 并为所选平台建符号链接，完成后重启 CLI / IDE。

- 支持的 `<platform>`：`gemini`、`codex`、`opencode`、`pi`、`openclaw`、`antigravity`、`vibe`、`vscode`、`hermes`、`cline`、`kimi`、`nanobot`、`kiro`
- 后续更新：`./install.sh --update`；卸载：`./install.sh --uninstall <platform>`

> **Cursor / VS Code Copilot**：克隆本 fork 后自动通过 `.cursor-plugin/plugin.json` / `.copilot-plugin/plugin.json` 发现插件。手动添加时在搜索框粘贴 `https://github.com/fanyb/Understand-Anything`。
> **Copilot CLI**：`copilot plugin install fanyb/Understand-Anything:understand-anything-plugin`

---

## 🔧 技术原理

### Tree-sitter + LLM 混合分析

把确定性的事情交给静态分析，把需要语义理解的事情交给 LLM：

- **Tree-sitter（确定性）** —— 将源码解析为具体语法树，提取结构性事实：导入、导出、函数 / 类定义、调用点、继承关系。同样的输入永远得到同样的输出，并作为增量更新的指纹基础。
- **LLM（语义）** —— 读取解析后的结构与原始源码，生成解析器做不了的事：plain-English 摘要、标签、架构层归属、业务领域映射、引导路径、语言概念标注。

### 多智能体架构

`/understand` 命令调用 5 个 agent，`/understand-domain` 增加第 6 个，本 fork 的 `/understand-link --llm-residual` 再增加一个：

| Agent | 职责 |
|-------|------|
| `project-scanner` | 扫描项目文件，检测语言和框架 |
| `file-analyzer` | 提取代码结构（函数、类和导入），生成图节点和边 |
| `architecture-analyzer` | 识别架构层 |
| `tour-builder` | 生成引导式学习路径 |
| `graph-reviewer` | 验证图的完整性和引用完整性 |
| `domain-analyzer` | 提取业务领域、流程和处理步骤（由 `/understand-domain` 使用） |
| `article-analyzer` | 从 wiki 文章中提取实体、论断和隐式关系（由 `/understand-knowledge` 使用） |
| `residual-matcher` | 从确定性预筛的候选小集里挑出跨服务调用的提供方（由 `/understand-link --llm-residual` 使用） |

文件分析器并行运行（最多 3 个并发）。支持增量更新——仅重新分析自上次运行以来发生更改的文件。

---

## 📦 与团队共享知识图谱

图谱就是一份 JSON 文件——**提交一次，团队成员就可以跳过整条流水线**。

**需要提交的内容：** `.understand-anything/` 下的全部文件，*除了* `intermediate/` 和 `diff-overlay.json`（本地临时文件）。

```gitignore
.understand-anything/intermediate/
.understand-anything/diff-overlay.json
```

`/understand-link` 的产物在 `.understand-link/` 下，同理排除 `intermediate/`。

---

## 🤝 贡献 / 与上游同步

本 fork 跟随上游 [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)。同步上游：

```bash
git remote add upstream https://github.com/Egonex-AI/Understand-Anything.git
git fetch upstream && git merge upstream/main
```

---

<p align="center">
  <strong>不再盲读代码，而是理解整个系统</strong>
</p>

## Star 历史记录

<a href="https://www.star-history.com/?repos=fanyb%2FUnderstand-Anything&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=fanyb/Understand-Anything&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=fanyb/Understand-Anything&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=fanyb/Understand-Anything&type=date&legend=top-left" />
 </picture>
</a>

<p align="center">
  MIT License &copy; Yuxiang Lin and Infinite Universe, Inc. · 中文优先 fork 由 fanyb 维护
</p>
