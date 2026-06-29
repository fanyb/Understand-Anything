# 多仓库 Dashboard 设计方案（跨服务下钻 · v1）

> 状态：**待最终确认**（v3，已并入专家 review 的修正）。本文件只描述设计，未写任何实现代码。确认后再进入实现阶段。
>
> 目标：让 `understand-link` 产出的 `system-graph.json`（服务 + 业务域 + 跨服务调用）能在 dashboard 里**可交互、可点节点**，并支持**点服务节点/跨服务边下钻**到对应服务自己的单仓图。

## 设计决策（已拍板）

| # | 决策 | 选定 |
|---|---|---|
| A | 启动入口 | **新建独立 skill `/understand-link-dashboard`** |
| B | 下钻 UX | **分屏并排**：左=系统概览，右=下钻的服务单仓图 |
| C | system-graph 类型/校验 | **提升到 core**（`./types` + `./schema` 共享） |
| D | 业务域呈现 | **域作 cluster 包裹服务节点**（React Flow group） |

## v3 修正要点（来自专家 review，附 file:line）

1. **纠正风险判断**：两个 React Flow 同屏**不是**主要风险——每个视图自带 `ReactFlowProvider`（`GraphView.tsx:1577`、`DomainGraphView.tsx:275`、`KnowledgeGraphView.tsx:288`），`App.tsx` 无顶层单一 provider，实例隔离是现成模式。
2. **真正的坑**：`DashboardContent` 是「独占整屏」的应用，**不能原样塞进右栏**。必须先抽成容器内自洽的 `<SingleRepoDashboard>`（见 §7 第 5a 步）。删除原 v2 里「零新 UI / 原样复用」的表述。
3. dev server 是**真重构**而非「仅参数化」；新增 `null` graphRef 过滤、`ref` 未规范化精确比对、`/config.json` 注入 `mode`（见 §3/§6）。
4. 双校验器「同 fixture 防漂移」是伪命题 → 改为各自畸形 fixture 分别测（见 §5/§8）。
5. decision D 复用已有 group 机制（`parentId`+`extent:'parent'`，`GraphView.tsx:1002-1003`；容器盒 `ContainerNode.tsx`），并明确 v1 用 dagre/手摆、不碰 ELK 自适应尺寸（见 §4.2）。

---

## 0. 范围（v1 做什么 / 不做什么）

**做（v1）：**
1. core 新增 `SystemGraph` 类型 + zod **结构**校验 `validateSystemGraph()`，浏览器安全，经 `./types` / `./schema` 导出。
2. 新「系统概览」视图：服务节点**按业务域聚成 group**，渲染跨服务 `calls` 边（按协议着色）+ `flow` 业务流。
3. **把现有 `DashboardContent` 抽成 `<SingleRepoDashboard>`**（容器内自洽），用于右栏；**单仓模式行为保持不变**（回归校验）。
4. **分屏布局**：左=系统概览（常驻），右=下钻进来的 `<SingleRepoDashboard>`，可拖拽分隔条。
5. 点**服务节点** → 右栏加载该服务 `knowledge-graph.json`；点**跨服务 `calls` 边** → 右栏下钻到 `from.(graphRef,nodeId)` 并选中，提供 from↔to 切换。
6. 子图**按需懒加载** + 服务端缓存；沿用现有 token 鉴权 + 路径白名单安全模型。
7. 概览信息面板：系统统计、选中服务信息、选中跨服务边信息、`unresolved[]` 列表。
8. 新 skill `/understand-link-dashboard` 启动系统模式。

**不做（留给 v1.1+，文末列明）：**
- 不做**三图及以上**同屏（v1 分屏只「概览 + 单个服务」两栏；调用方/提供方两服务并排是 v1.1）。
- 不做跨多跳调用链路追踪（只支持单条边 from↔to 跳转）。
- `flow` 仅做高亮序列，不做动画/LLM 命名排序。
- `unresolved[]` 只在侧栏列表展示，不画到画布。
- 不做域盒子的 ELK 自适应尺寸（用 dagre/手摆）。

---

## 1. 背景

### 1.1 现状：dashboard 是「独占整屏的单仓应用」
- `App.tsx` 经 `dataUrl()` 拉 `/knowledge-graph.json` 等，core `validateGraph()` 校验后进 Zustand store 的单个 `graph` / `domainGraph`。`Dashboard` 包装器（`App.tsx:110-208`）**挂载即无条件 fetch** 顶层图。
- 根节点 `h-screen w-screen`（`App.tsx:444`）；多个全屏弹层 `fixed inset-0`（展开版 CodeViewer `App.tsx:670`、`KeyboardShortcutsHelp.tsx:35`、`PathFinderModal.tsx:111`）；首次访问自动弹 onboarding（`App.tsx:42-47,706`）；键盘监听绑在 `document`（`useKeyboardShortcuts.ts:47`），`/` 用全局 `querySelector('[data-testid="search-input"]')`（`App.tsx:316`）。
- dev server（`vite.config.ts` 中间件）从 `GRAPH_DIR/.understand-anything/` 读，全部 `?token=` 鉴权（`isProtectedEndpoint` 精确路径匹配，`vite.config.ts:250-256`）；`/file-content.json` 经 `readSourceFile` 按单一 `projectRoot`（`findGraphFile`，`vite.config.ts:15-28,130-135`）+ `graphFilePathSet` 白名单（`:55-70,147`）+ containment（`:136-145`）+ `normalizeGraphPath` 相对化（`:34-53`，仅对 `startsWith(projectRoot)` 的路径）吐源码。
- `/understand-dashboard` skill 以 `GRAPH_DIR=<项目> npx vite` 启动单仓实例。

→ 「独占整屏」是 §7 第 5a 步必须先拆解的根因。

### 1.2 契约：`system-graph.json`（确切形状，已对脚本核实，review 确认准确）
来源 `assemble-system-graph.mjs:75-82`，落盘于 `<workspace>/.understand-link/system-graph.json`：

```jsonc
{
  "version": "1.0.0",
  "kind": "system",
  "services": [
    { "id": "aurora-service", "repo": "aurora",
      "domains": ["派单", "仿真"],
      "graphRef": "aurora-service/.understand-anything/knowledge-graph.json",
      "stats": { "nodes": 3411, "edges": 8645 } }
  ],
  "domains": [
    { "id": "domain:派单", "name": "派单", "serviceIds": ["aurora-service", "backend-aurora"] }
  ],
  "edges": [
    { "id": "x1", "type": "calls", "protocol": "dubbo", "domain": "派单",   // domain 可能 undefined
      "sourceService": "backend-aurora", "targetService": "aurora-service",
      "key": "com.hk...DispatchPlanOpenService#queryPlan",
      "from": { "graphRef": "backend-aurora/.../knowledge-graph.json", "nodeId": "file:.../X.java" },  // graphRef 可能 null
      "to":   { "graphRef": "aurora-service/.../knowledge-graph.json",  "nodeId": "file:.../Y.java" },
      "confidence": 1.0, "evidence": "@DubboReference 接口匹配" },
    { "id": "f1", "type": "flow", "domain": "派单", "sequence": ["backend-aurora","aurora-service"], "via": ["dubbo"] }
  ],
  "unresolved": [ { "kind": "http", "key": "POST /crm/...", "consumerService": "...", "nodeId": "...", "reason": "..." } ]
}
```

**关键点：**
- `graphRef`（含 `from/to.graphRef`）相对 `<workspace>` 根，**可能含 `../`** 指向同级仓库 → dev server 解析与白名单依据。
- `from/to.graphRef` **可能为 `null`**（服务无 graphRef 时，`resolve-cross-edges.mjs:60-61`，校验器仅 warn `validate-system-graph.mjs:72-74`）→ 白名单与下钻须过滤 null、对 null 端点禁用下钻。
- `edge.domain` **可能 undefined**（`resolve-cross-edges.mjs:56`）→ 着色/信息面板须容错。
- system-graph **不携带 domainRef**（`assemble-system-graph.mjs:27-34` 丢弃）→ 域图按 `dirname(graphRef)/domain-graph.json` **约定**推导（与 `manifest.example.json:9-10` 的 `domainRef` 实际吻合，但仅约定、需探测存在性）。

---

## 2. 总体架构：分屏（概览 ‖ 服务详情）

```
┌────────── 系统概览（左，常驻）──────────┐┃┌──── 服务详情（右，下钻后出现）────┐
│  SystemGraphView (自带 ReactFlowProvider)│┃│  <SingleRepoDashboard>            │
│  · 业务域 group 包裹服务节点            │┃│  (从 DashboardContent 抽出，       │
│  · 跨服务 calls 边 / flow 业务流        │┃│   容器内自洽，自带 Provider)       │
│  · 选中 → 概览信息面板                  │┃│  · 未下钻时显示占位                │
│  driven by: systemStore（独立）         │┃│  driven by: 现有 store（追加字段） │
└──────────────────────────────────────────┘┃└────────────────────────────────────┘
                              ↕ 可拖拽分隔条（默认约 45 / 55）
```

- **左栏**独立小 store（`systemStore`），与现有 store 完全隔离（现有 `useDashboardStore` 是模块级 `create()` 单例 `store.ts:289`，唯一全局 `reactFlowInstance` `store.ts:323` 留给右栏）。
- **右栏**是抽出的 `<SingleRepoDashboard>`，由现有 store 驱动（`graph` = 下钻服务）。下钻态白拿单仓全部功能（搜索/persona/code viewer/文件树），但**需要先做 §7 第 5a 步的容器化改造**（不是零成本）。
- React Flow 实例隔离已是现成模式，非风险点。

---

## 3. 数据服务层（dev server 中间件扩展 —— 真重构）

新增 `LINK_DIR` 环境变量 = workspace 根。系统模式用它；单仓模式 `GRAPH_DIR` 不变。

新增端点（加入 `isProtectedEndpoint` 精确路径集；query string 不影响 pathname 匹配）：

| 端点 | 解析 | 白名单 / 安全边界 |
|---|---|---|
| `GET /system-graph.json` | `${LINK_DIR}/.understand-link/system-graph.json` | token |
| `GET /service-graph.json?ref=<graphRef>` | `resolve(LINK_DIR, ref)` | `ref` **未规范化字符串**精确命中 `services[].graphRef` ∪ 非空 `edges[].from/to.graphRef` 集合（含 `../` 也只认这张白名单；存集合与入参两侧都不得 `path.normalize`，否则成为唯一漏洞） |
| `GET /service-domain-graph.json?ref=<graphRef>` *(可选)* | `dirname(ref)/domain-graph.json` | 同集合派生；约定路径，需探测存在性 |
| `GET /file-content.json?ref=<graphRef>&path=<file>` | base = `dirname(dirname(ref))`，文件 = `resolve(LINK_DIR, base, path)` | `ref` ∈ 白名单 + `path` ∈ 该服务图 filePath 集 + 非绝对 + 无 `..` + ≤1MB + 非二进制 |

**这不是「仅参数化 base+allowlist」**：需改 `findGraphFile` 单根推导 → 按 ref 派生 per-service 根、改 containment 检查（`:136-145`）、改 `normalizeGraphPath` 让其按同级仓库自身根相对化（现仅对 `startsWith(projectRoot)` 生效 `:34-53`）。服务端缓存已加载 per-service 图以派生 filePath 白名单。

**安全论证：** system-graph 本地生成可信；外部输入仅 URL 的 `ref`/`path`。`ref` 用「未规范化精确集合成员」校验，`path` 沿用现有三层校验 + null graphRef 过滤。

---

## 4. 前端

### 4.1 状态
**新增独立 `src/systemStore.ts`（左栏专用）：** `systemGraph` / `selected:{kind:"service"|"edge",id}` / actions。
**现有 `store.ts` 仅追加：**
```ts
serviceGraphCache: Map<string, KnowledgeGraph>   // graphRef → 已校验子图
activeServiceRef: string | null
loadServiceGraph(ref, opts?: { selectNodeId })   // 命中缓存或 fetch → validateGraph → setGraph → selectNode
```
跨服务跳转：左栏选 `calls` 边 → `loadServiceGraph(edge.from.graphRef, { selectNodeId: edge.from.nodeId })`；信息面板给 from↔to 切换。**from/to.graphRef 为 null 时禁用对应按钮。**

### 4.2 概览视图 `SystemGraphView`（新，React Flow，自带 Provider）
- **业务域 group（决策 D，复用现有机制）**：每个 `domains[]` → 一个 group 父节点；服务节点作子节点，沿用现有 `parentId` + `extent:'parent'` 写法（参照 `GraphView.tsx:1002-1003`，容器盒参照 `ContainerNode.tsx`）。
  - ⚠️ 现有 `DomainClusterNode.tsx`/`LayerClusterNode.tsx` 是**扁平点击卡片，不是** group 包裹器（`DomainClusterNode.tsx:23-33`）→ 新建独立的域 group 组件，勿误用。
  - **多域冲突解法**：每个服务归一**主域** = 其 `domains[]` 中关联跨服务边最多的域（并列按域名排序取首）；无域服务归 "ungrouped"。**次域**用服务节点徽标 +（可选）淡虚线表达。已知取舍。
- **布局**：v1 用 **dagre 或手摆固定坐标**（服务约 10–50 个）；**不做** ELK 域盒自适应尺寸（那是 `store.ts:216-228` containerLayoutCache 的复杂 Stage-2 逻辑，明确排除）。
- 节点 `ServiceNode`：`id`/`repo`/`stats.nodes`。边：`calls` 按 `protocol` 着色、`confidence<0.7` 虚线、`domain` 可缺省；`flow` 沿 `sequence` 淡色序列。

### 4.3 信息面板
- `SystemOverview`（idle）：N 服务 / M 域 / K 跨服务调用 / U 未解析 + `unresolved[]` 列表。
- `ServiceInfo`（选中服务）：repo、domains、stats、**「在右侧展开 →」**。
- `EdgeInfo`（选中 `calls` 边）：protocol、key、confidence、evidence、`from → to`、**「展开调用方/提供方」**（null 端点置灰）；`domain` 缺省时不显示域行。

---

## 5. 类型与校验（决策 C：放 core）

**core 新增（浏览器安全；`types.ts` 零 import、`schema.ts` 仅依赖已有的 zod，`App.tsx:2` 已在用）：**
- `src/types.ts`：`SystemGraph`/`SystemService`/`SystemDomain`/`SystemCallsEdge`/`SystemFlowEdge`/`GraphRef`，经 `./types` 导出。
- `src/schema.ts`：zod `SystemGraphSchema` + `validateSystemGraph(data)`（**结构**校验，返回 `{success,data,issues,fatal}`），经 `./schema` 导出。
- per-service 子图继续走现有 `validateGraph()`。
- ⚠️ **不宣称「与 understand-link JS 校验器防漂移」**：后者（`validate-system-graph.mjs:47-120`）是**语义/完整性**校验（service-ref 完整性、悬空 nodeId、孤儿、环、低置信），与 core 的结构校验**关注点几乎不相交**；「同 fixture 都通过」只证明该 fixture 没坏。一致性靠**各自的畸形 fixture 分别测**（§8）。
- 注：decision C 技术安全，但当前**无第二个 TS 消费方**（understand-link 用 JS、dashboard 是唯一 TS reader）；代价是 dashboard 依赖 `pnpm --filter @understand-anything/core build`（经 alias 解析 `dist/`，`vite.config.ts:195-198`）。理由按「将来可能复用」即可，不夸大。

---

## 6. 启动方式（决策 A：新 skill）

新建 `/understand-link-dashboard`（启动样板参照 `/understand-dashboard/SKILL.md`）：
1. 校验 `<workspace>/.understand-link/system-graph.json` 存在（否则提示先跑 `/understand-link`）。
2. 复用同一套 dashboard 代码定位逻辑（`CLAUDE_PLUGIN_ROOT/packages/dashboard` 等）。
3. `pnpm install` + `pnpm --filter @understand-anything/core build`。
4. `LINK_DIR=<workspace> DASHBOARD_MODE=system npx vite --host 127.0.0.1` 后台启动。
5. **`mode` 注入**：`/config.json` 现仅返回 `{autoUpdate,outputLanguage}`（`vite.config.ts:276-292`），无 `mode`；需让其在 `DASHBOARD_MODE=system` 时附加 `mode:'system'`，前端据此进系统分屏模式、并**跳过单仓顶层 bootstrap fetch**。
6. 抓取并上报带 token 的 URL。

---

## 7. 实施步骤（分阶段，每步带验证；确认后执行）

1. **core 类型 + `validateSystemGraph`（结构 zod）+ 导出** → 验证：core 单测；`pnpm --filter @understand-anything/core build` 通过；浏览器安全。
2. **Fixtures**：合法 `system-graph.json` + 2 个迷你服务图 + `../` graphRef 用例 + `null` graphRef 用例 + **针对各校验器的畸形 fixture**（core 结构 / understand-link 语义各一组）→ 验证：合法 fixture 双过、畸形 fixture 被各自校验器拒。
3. **dev server**：`LINK_DIR` + 四端点 + 加入 `isProtectedEndpoint` + per-service 根派生/containment/`normalizeGraphPath` 改造 + null 过滤 + 未规范化 ref 精确比对 + `/config.json` 注入 `mode` → 验证：端点单测（白名单命中/越界拒/防穿越/缺 token 401/`../` 命中可读·不在白名单拒/null ref 拒）；现有 `/file-content.json` 不回归。
4. **systemStore + 现有 store 追加 `loadServiceGraph`/缓存** → 验证：store 单测（命中缓存、不重拉、selectNode 生效、null 端点禁用）。
5a. **抽 `<SingleRepoDashboard>`（容器内自洽）** → 把 `DashboardContent` 根改 `h-full w-full`；四个 `fixed inset-0` 弹层 + onboarding 作用域收进该子树或系统模式下 gate；键盘/搜索监听按 pane 容器或焦点限定；系统模式跳过单仓 bootstrap fetch。**验证：单仓模式 `/understand-dashboard` 行为零回归（手动 + 现有测试）。**
5b. **分屏外壳** → 可拖拽分隔条 + 左 `SystemGraphView`（占位）+ 右 `<SingleRepoDashboard>`（占位）同屏 → 验证：两画布各自缩放互不串扰、弹层不越界盖左栏、性能可接受。
6. **SystemGraphView：域 group + ServiceNode + 边 + dagre/手摆布局 + 主域归属** → 验证：fixture 跑 `pnpm dev:dashboard`，能渲染/能点；多域徽标正确。
7. **信息面板（SystemOverview/ServiceInfo/EdgeInfo）** → 验证：选服务/选边信息正确、null/缺省容错、按钮可点。
8. **下钻接线：左选 → 右加载子图并选中锚点 + from↔to 切换** → 验证：点服务进子图；点边进 from/to；占位↔详情切换正常。
9. **新 skill `/understand-link-dashboard`** → 验证：真实 workspace 启动，URL 带 token，端到端分屏下钻通；onboarding 不弹、顶层不 404。
10. **文档 + 版本号**（推送时再做）→ 五个 manifest 版本号同步 bump；更新 readme。

## 8. 测试计划
- 单测：`validateSystemGraph`（core，结构）；dev server 新端点白名单/穿越/token/null；store drill/缓存/null 禁用。
- 校验器测试：**各自畸形 fixture 分别测**（不靠「同 fixture 双过」证明一致性）。
- 端到端：手动 smoke 概览→点服务/边下钻→from/to 切换→拖拽分隔条；**单仓模式回归**。
- 回归：`pnpm test` 全绿（现 274）、`pnpm lint` 干净、dashboard build + core build 通过。

## 9. v1.1+（明确不在 v1）
- 调用方/提供方两服务并排（三栏）。
- 跨多跳调用链追踪。
- `flow` 动画/有序命名。
- `unresolved[]` 画布可视化与回写。
- 域盒 ELK 自适应尺寸。

## 10. 风险（已按 review 重排）
- **【最高】`DashboardContent` 独占整屏**：根 `h-screen w-screen`、四个 `fixed inset-0` 弹层、自动 onboarding、document 级键盘、顶层 bootstrap fetch → §7 第 5a 步先容器化，第 5b 步才接分屏。这是 v1 最大工作量与回归面。
- **dev server 真重构**：per-service 根/containment/相对化改造（§3）。
- **服务属多域 + group 单父**：主域归属 + 次域徽标（§4.2）。
- **null graphRef / undefined domain**：白名单过滤 + UI 容错（§1.2/§4）。
- **`graphRef` 含 `../`**：未规范化精确白名单（§3）。
- **双校验器关注点不相交**：各自畸形 fixture（§5/§8）。
- 两个 React Flow 同屏：**非风险**（provider 自带隔离）。
- 中文域名 id（`domain:派单`）：`encodeURIComponent`。
