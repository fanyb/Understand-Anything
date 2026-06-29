# `/understand-link` 设计文档：跨服务（多仓库）知识图谱关联技能

> 状态：**v0.1 范围已拍板**（决策见 §13），技术栈以本项目调研为基线（§6.1）。本文只规划需求与技术方案，不含实现。
> 目标读者：维护 understand-anything 技能集 / Aurora 平台架构的同学。
> 关键决策速览：服务清单走**手维护 manifest**（网关前缀/基路径由使用者提供）｜各服务**必须**先有 `knowledge-graph.json` + `domain-graph.json`，缺失则**报错提示使用者去补**｜registry **默认纯 JSON**、配置切 SQLite｜消费形态 = **Dashboard 总览视图 + agent MCP**｜先交付 **v0.1 纯确定性骨架**。

---

## 1. 背景

`/understand` 为**单个仓库/服务**生成 `knowledge-graph.json`（文件/类/函数 + import/contains/calls 等边）。
`/understand-domain` 为单服务生成 `domain-graph.json`（业务域 / 业务流 / 流程步骤）。

但二者都**止于单服务边界**：跨服务的调用关系（Dubbo/HTTP/MQ）和跨服务的业务流，靠静态 import 解析不出来，因此现状是「每个服务一张孤立的图」。

我们要新增一个技能 `/understand-link`（暂名），把 **N 个服务的子图关联成一张系统级图**，且满足三条硬性要求 ↓。

## 2. 需求

| 编号 | 需求 | 解读 |
|---|---|---|
| R1 | **调用框架 + 业务领域都能关联上** | 既要技术调用拓扑（Dubbo/HTTP/MQ 的"谁调谁"），又要业务领域视角（某业务流跨了哪些服务）；且两者要能**交叉查询**（如"派单域内的所有跨服务调用"） |
| R2 | **支持增量关联** | 某个服务的子图重生成后，只重算它的边界与受影响的跨服务边，不全量重跑 |
| R3 | **面向 200+ 服务** | 数据结构、性能、脚本必须按"两三百个服务、合计可能上百万节点"来设计，不能用单张大平图 |

### 推导出的需求
- R4 **稳定的"键"**：跨服务边必须用机器可跟随的 `(graphRef, nodeId)` 键指回子图，供人下钻、供 AI 遍历（详见 §5）。
- R5 **可观测**：无法解析的消费方（调了一个没有已知提供方的接口）要进 `unresolved` 报告，不能静默丢。
- R6 **低 LLM 成本**：200+ 服务下，关联主体必须确定性（注解/类型名/topic 字符串匹配），LLM 只用于少量模糊残差。

## 3. Goals / Non-Goals

**Goals**
- 产出一张**联邦式系统图** `system-graph.json`：节点=服务+业务域，边=跨服务调用+域归属+业务流，每条跨服务边带回指子图的键。
- 维护一个**边界注册表（registry）**作为关联与查询的索引。
- 增量、并行、可重入；对 AI 与人都"先总览后下钻"。

**Non-Goals**
- 不重做单服务分析（消费 `/understand` 的产物，不替代它）。
- 不构建"把 200 服务压平成一张图"的大平图（§4 说明为什么）。
- 原始 `RestTemplate`/`axios` URL 拼接式 HTTP 调用**不追求 100% 精度**，以"尽力匹配 + unresolved 兜底"为准。

## 4. 核心设计决策：联邦式两层 + 边界注册表

**不做大平图。** 200+ 服务合计节点量可能到百万级——单张 `knowledge-graph.json` 无法渲染、无法增量、跨服务边手工加且易腐。

采用**两层 + 中间索引**：

```
┌─────────────────────────────────────────────┐
│  Tier-0  系统图 system-graph.json (总览)       │  服务/域 为节点，跨服务调用/业务流 为边
│          每条边带 (graphRef,nodeId) 键 ↓        │
├─────────────────────────────────────────────┤
│  Registry  boundary registry (索引)            │  provides/consumes 倒排索引；join 与查询都靠它
├─────────────────────────────────────────────┤
│  Tier-1  各服务 knowledge-graph.json (明细)     │  N 张，原样不动，按需懒加载
│          (+ 可选 domain-graph.json)            │
└─────────────────────────────────────────────┘
```

**关键机制：两阶段解析（boundary extract → global join）**，这是同时满足 R2/R3/R6 的核心：

- **Phase A 边界提取（每服务本地、可并行、可增量）**：从每个服务抽出它对外的 **provides（提供）** 与 **consumes（消费）** 集合（按协议分类），写成 `boundaries/<svc>.json`。只依赖该服务自身 → 改谁只重算谁。
- **Phase B 全局连接（哈希 join、极廉价）**：把所有服务的 `consumes` 按"键"去匹配别人的 `provides`，生成跨服务边。复杂度 O(Σ边界数)，**不是 O(服务²)**。

增量天然成立：服务 K 变了 → 只重跑 K 的 Phase A → upsert 注册表 → 重跑 join（廉价）→ 重写系统图。

## 5. 数据结构

### 5.1 边界描述符 `boundaries/<serviceId>.json`（Phase A 产物）
```jsonc
{
  "serviceId": "aurora-service",
  "repo": "aurora",
  "graphRef": "aurora/.understand-anything/knowledge-graph.json",
  "domainRef": "aurora/.understand-anything/domain-graph.json",   // 可选
  "sourceHash": "sha256:…",        // 增量判脏：源码树/或 kg.json 的哈希
  "generatedAt": "2026-06-28T…",
  "domains": ["派单", "仿真"],       // 该服务参与的业务域
  "provides": [
    { "kind": "dubbo", "key": "com.hk.simba.aurora.open.api.DispatchPlanOpenService#queryPlan",
      "nodeId": "file:aurora-service/…/DispatchPlanOpenServiceImpl.java", "domain": "派单", "confidence": 1.0 },
    { "kind": "http",  "key": "POST /aurora/dispatch/plan",
      "nodeId": "file:…/DispatchController.java", "domain": "派单", "confidence": 0.9 },
    { "kind": "mq",    "key": "topic:DISPATCH_PLAN_CHANGED", "role": "producer",
      "nodeId": "file:…/DispatchPublisher.java", "confidence": 0.95 }
  ],
  "consumes": [
    { "kind": "dubbo", "key": "com.hk.simba.workorder.open.WorkorderOpenService#close",
      "nodeId": "file:…/WorkorderManager.java", "confidence": 1.0, "evidence": "@DubboReference" },
    { "kind": "http",  "key": "POST /crm/customer/query", "targetHint": "crm-service",
      "nodeId": "file:…/CrmManager.java", "confidence": 0.6, "evidence": "HttpUtils/RestTemplate URL（Apollo 配置，本项目无 Feign）" },
    { "kind": "mq",    "key": "topic:WORKORDER_DONE", "role": "consumer", "nodeId": "file:…/WorkorderListener.java" }
  ]
}
```
- **键的约定**：`dubbo` = 接口 FQN（可带 `#method`）；`http` = `METHOD 归一化路径`；`mq` = `topic:NAME`（可带 `:tag`）。
- `nodeId` + `graphRef` = 回指子图的稳定键（R4）。利用 §子图前缀 id 已全局唯一的特性。

### 5.2 注册表 registry（索引；**默认纯 JSON**，配置可切 SQLite，见 §9）

**默认实现**：单文件 `registry.json`（`{ services, provides, consumes, serviceDomains }` 四个数组）+ 进程内构建倒排 `Map`。200+ 服务、合计约 1 万条边界，纯 JSON 全量读入仅几 MB、join 毫秒级，完全够用，且人可读、易 git diff。
**配置切换**：`manifest` 里 `registry.backend: "sqlite"` 时改用 SQLite（同一套逻辑表 schema），用于规模继续增长或想给 AI/MCP 跑 SQL 的场景。提取/join/组装脚本面向一个**抽象 registry 接口**，两种后端可互换。

逻辑表（JSON 数组键名 = 表名）：
- `service(serviceId, repo, graphRef, domainRef, sourceHash, nodes, edges, generatedAt)`
- `provide(serviceId, kind, key, nodeId, domain, confidence)`  —— 建索引 `(kind,key)`
- `consume(serviceId, kind, key, nodeId, targetHint, confidence)` —— 建索引 `(kind,key)`
- `service_domain(serviceId, domain)`
- `cross_edge(...)`（join 结果缓存，便于增量 diff）

倒排查询（供 AI/人）：`provide(kind,key)→service`、`domain→services`、`service→boundaries`，O(1)~O(logN)。

### 5.3 系统图 `system-graph.json`（Tier-0 产物）
```jsonc
{
  "version": "1.0.0",
  "services": [ { "id":"aurora-service","repo":"aurora","domains":["派单","仿真"],
                  "graphRef":"…","stats":{"nodes":3411,"edges":8645},"layers":["…"] } ],
  "domains":  [ { "id":"domain:派单","name":"派单","serviceIds":["fe-…","backend-aurora","aurora-service"] } ],
  "edges": [
    { "id":"x1", "type":"calls", "protocol":"dubbo", "domain":"派单",
      "sourceService":"backend-aurora", "targetService":"aurora-service",
      "key":"com.hk.simba.aurora.open.api.DispatchPlanOpenService#queryPlan",
      "from": { "graphRef":"backend-aurora/…/kg.json", "nodeId":"file:backend-aurora/…/DispatchPlanManager.java" },
      "to":   { "graphRef":"aurora/…/kg.json",         "nodeId":"file:aurora/…/DispatchPlanOpenServiceImpl.java" },
      "confidence":1.0, "evidence":"@DubboReference 接口匹配" },
    { "id":"f1", "type":"flow", "domain":"派单",
      "sequence":["fe-backend-aurora","backend-aurora","aurora-service"], "via":["http","dubbo"] }
  ],
  "unresolved": [ { "kind":"dubbo","key":"…OpenService","consumerService":"X","reason":"注册表无提供方（疑似外部/未纳管服务）" } ]
}
```
**R1 落点**：跨服务 `calls` 边带 `domain` 字段（取自 provide 侧的域标签）⇒ 技术拓扑与业务域**在同一条边上交叉**，可直接查"某域内的所有跨服务调用"。

## 6. 跨服务边提取策略（按可靠性分层，先确定性后 LLM）

| 协议 | provides 抽取 | consumes 抽取 | join 键 | 可靠性 | 需 LLM？ |
|---|---|---|---|---|---|
| **Dubbo** | `@DubboService` + `implements *OpenService` 的接口 FQN | `@DubboReference` 字段类型 | 接口 FQN(+method) | ★★★ 最高 | 否 |
| **HTTP-raw** | Spring MVC `@PostMapping`/`@GetMapping`（+类级 `@RequestMapping`）归一化路由 | fe service 模块 / `RestTemplate` 的 URL 串 | 归一化路由（模糊） | ★~★★ 中 | 残差需 LLM |
| **MQ（自封装）** | `MqSendService` 发送点的 topic | `AbstractRocketMqHandler` 子类的 topic | topic(+tag) | ★★ 中高 | 常量/配置间接时需解析 |
| **DB 共享**（可选） | 写同一 `table:` 节点的服务 | 同 | 表名 | ★ 低 | 否 |

> ⚠️ 本项目**无 Feign**（原 Feign 行已删）；Dubbo Consumer 仅 `@DubboReference`（无旧式 `@Reference`）；无 gRPC / Kafka。

- **复用已有子图**：Dubbo 的 `implements` 边、`table:` 节点、controller 类节点，子图里已有 → 边界提取大部分是"读子图 + 对源码做一遍注解/类型名的 tree-sitter/正则扫描"，**单服务本地、廉价**。
- **归一化**：HTTP 路由需要"服务基路径/网关前缀"映射表（每服务一行，**由使用者在 manifest 提供**），否则 `/plan` 与 `/aurora/dispatch/plan` 对不上。
- **LLM 只兜模糊残差**：raw-URL 匹配不上的、跨域业务流的命名与排序，才走一轮**针对性小 LLM**，量极小（v0.1 不做，仅列 unresolved，见 §13）。

### 6.1 本项目（aurora）技术栈调研结论（v0.1 提取器的基线）

实测三仓库（排除 `target/`）：

| 框架 | 现状 | 提取器方案 |
|---|---|---|
| **Dubbo** | Provider `@DubboService`×33 且都 `implements *OpenService`；Consumer `@DubboReference`×57 | tree-sitter 取注解 + `implements` 接口 FQN（已在子图里）。**最准、v0.1 必做、零 LLM** |
| **HTTP Provider** | backend `@PostMapping`×132 / `@RequestMapping`×33 / `@GetMapping`×17 ≈150 路由 | Spring MVC 注解 → 类级 `@RequestMapping` 拼方法级 `@*Mapping`，叠加 manifest 的服务基路径/网关前缀归一化 |
| **HTTP Consumer (fe→backend)** | fe `axios` + `src/service/modules/*`，URL **非字面量 `url:`** 写法 | 需按 fe 约定写适配器（解析 service 模块的请求封装）；置信度中，v0.1 可暂缓或标记低置信 |
| **HTTP 出站三方** | Hutool `HttpUtils`×5 + `RestTemplate`×4（多为 test/config），URL 多来自 Apollo | 基本是 **fleet 外部**调用 → 归 `unresolved`/external，不强求 |
| **MQ** | RocketMQ **公司自封装**：消费方继承 `AbstractRocketMqHandler`，生产方 `MqSendService`；**无**标准 `@RocketMQMessageListener`/`rocketMQTemplate`。`@EventListener`×13 为进程内事件须排除 | 写**项目专属 MQ 适配器**：找 `AbstractRocketMqHandler` 子类（consumer）与 `MqSendService.send(...)`（producer），topic 来源（`getTopic()`/常量/配置）需进一步确认 |
| **gRPC / Kafka** | 0 | 不纳入 |
| **网关** | 组织级 sisyphus HTTP→Dubbo 网关（app/backend/api/open 四类） | 作为 HTTP↔Dubbo 映射上下文；manifest 里记录每服务的网关前缀 |

> 结论：**Dubbo 是跨服务关联的主骨架**（确定性最高、覆盖 intra-fleet 调用），v0.1 以 Dubbo 为核心 + HTTP Provider 路由提取；MQ 因自封装需专属适配器，HTTP Consumer(fe) 与出站三方置信度低、优先级靠后。技术栈"后续可补充"——其它服务若用了 Feign/gRPC/不同 MQ 封装，按本表新增适配器即可（提取器按协议插件化，见 §10）。

## 7. 业务领域关联（R1 的"领域"半边）

1. **服务→域归属（硬性前置）**：每个服务**必须**已有 `domain-graph.json`，从中取 domains。**缺失则该服务的边界提取直接报错并提示使用者**："服务 `<svc>` 缺少 domain-graph.json，请先运行 `/understand-domain` 后再纳入关联"——不做启发式推断兜底（避免低质量域标签污染跨服务关联）。`knowledge-graph.json` 同理为硬前置（缺失同样报错提示去跑 `/understand`）。校验在 Phase A 入口处统一做（见 §11 阶段 0/1 与 §13 决策②④）。
2. **域节点 + service↔domain 边**进系统图。
3. **业务流（flow）边**：把跨服务 `calls` 边按域聚合，沿协议方向串成序列（如 派单：fe下单 →HTTP→ backend受理 →Dubbo→ aurora-service调度 →MQ→ 通知）。骨架由 §6 的边确定性推出；**命名/排序/补缺**可选 LLM。
4. **交叉**：`calls` 边携带 `domain`，`flow` 边引用具体 `calls` 边 id ⇒ 调用框架与业务领域在数据层完全打通。

## 8. 增量设计

- **判脏**：每个 `boundaries/<svc>.json` 带 `sourceHash`（服务源码树哈希或其 `knowledge-graph.json` 哈希）。`link --changed` 时比对，找出变更服务集 ΔS。
- **重算范围**：
  1. 仅对 ΔS 重跑 Phase A（重的一步，但已被限定到少数服务）；
  2. upsert 注册表；
  3. 重跑 join——可全量（廉价）或只重解析"键命中 ΔS 的 provide/consume"的边；
  4. 重写 `system-graph.json`，并 **diff** 出"新增/消失的跨服务边"供评审。
- **幂等**：边以稳定 join 键标识，重跑结果稳定可比对。
- **触发**：每服务独立 git 或 mtime/hash；与 `/understand` 各自的增量解耦。

## 9. 性能与规模（200+ 服务）

| 关注点 | 方案 |
|---|---|
| 总节点量 | 不进系统图。系统图只有 O(服务 + 跨服务边) ≈ 数千，明细懒加载 |
| Phase A | 天生可并行、服务本地、按 `sourceHash` 缓存；只重算变更服务 |
| Phase B join | `(kind,key)` 哈希连接，O(Σ边界)。200×~50 ≈ 1万条，毫秒级 |
| 查询索引 | 倒排：`provide(kind,key)→svc`、`domain→svc`、`svc→boundaries` |
| 存储 | **默认纯 JSON**（`registry.json` + 各 `boundaries/<svc>.json`，人可读、易 diff、增量 upsert 即重写单服务文件）；`registry.backend:"sqlite"` 可选切 SQLite（规模再涨或需 SQL 查询时）。脚本面向抽象 registry 接口，后端可换 |
| 明细加载 | 仅在下钻时按 `(graphRef,nodeId)` 拉单图单节点，从不全局 union |
| AI 上下文 | 先喂极小系统图当路由表，再按需拉子图 → 分层检索，省 token |

## 10. 脚本与工具拆分（与 understand-anything 现有风格一致：确定性脚本 + 少量 LLM）

```
skills/understand-link/
  SKILL.md
  manifest.schema.json            # 服务清单 schema（serviceId, repo路径, graphRef, domainRef, 网关前缀/基路径, 协议开关, registry.backend）
  check-readiness.mjs             # 阶段0：校验 manifest 内每个服务的 kg.json/domain-graph.json 是否就绪，缺失→报错提示去补
  extract-boundaries.mjs          # Phase A 调度：对"就绪且变更"的服务跑各协议提取器 → boundaries/<svc>.json
  extractors/                     # ★ 按协议插件化（新栈只需加一个文件）
    dubbo.mjs                     #   @DubboService+implements / @DubboReference  —— v0.1 必做，零 LLM
    http.mjs                      #   Provider: Spring MVC @*Mapping；Consumer: fe/RestTemplate URL（置信度中）
    mq.mjs                        #   自封装：AbstractRocketMqHandler 子类 / MqSendService（topic 来源待确认）
  registry/                       # ★ 抽象后端，json 默认、sqlite 可选
    json-store.mjs  sqlite-store.mjs
  build-registry.mjs              # upsert 边界 → registry（走抽象接口）
  resolve-cross-edges.mjs         # Phase B：(kind,key) 哈希 join → cross_edge + unresolved（无 LLM）
  assemble-system-graph.mjs       # 组装 system-graph.json（服务/域节点 + 调用边 + flow 骨架）
  validate-system-graph.mjs       # 校验：悬空键、unresolved 统计、环、孤儿服务
  prepare-residual.mjs            # v0.3 Phase 4c-1：确定性预筛——每条 unresolved 给同协议候选小集
  merge-residual.mjs              # v0.3 Phase 4c-3：校验 agent 选择并折成 via:"llm" 边（置信封顶）
  flow-namer.md                   #   可选（未做）：业务流命名/排序
```
> residual-matcher agent 落在插件顶层 `agents/residual-matcher.md`（自动发现、可作
> `understand-anything:residual-matcher` 派发），即 Phase 4c-2 的"从候选里挑一个"。
- **提取器按协议插件化**：每个 `extractors/<proto>.mjs` 实现统一接口 `extract(serviceCtx) → {provides[], consumes[]}`。③ 的"其它服务用了别的栈（Feign/gRPC/别的 MQ 封装）"只需新增一个插件，不改主流程。
- **registry 抽象后端**：`json-store` / `sqlite-store` 实现同一 `upsert/query/join` 接口，⑤ 切换零侵入。
- 重活（就绪校验、边界提取、join、组装、校验）全是**确定性 Node 脚本**，v0.1 **零 LLM**；agent v0.2+ 才接入兜残差。
- 与现有脚本一致：每脚本读写明确的 JSON 中间产物，便于增量/重入/调试。

## 11. Skill 工作流（阶段）

0. **发现 + 就绪校验**：读**手维护 manifest**（唯一入口）。对每个服务校验 `knowledge-graph.json` 与 `domain-graph.json` 是否就绪：
   - 缺失 → **报告并跳过该服务**（决策②④），明确提示"请先对 `<svc>` 跑 `/understand` 和/或 `/understand-domain`"；
   - 就绪集合 = 本次纳入关联的服务。后续慢慢补的服务，补一个、下次 `--changed` 自动纳入一个。
1. **边界提取**（仅对"就绪且变更"的服务，并行、增量）→ `boundaries/<svc>.json`（按协议插件提取）
2. **注册表 upsert** → registry（默认 JSON）
3. **跨服务解析**（`(kind,key)` join）→ cross_edge + unresolved
4. **领域关联**（服务↔域归属 + flow 骨架；v0.1 不做 LLM 命名）
5. **系统图组装** → `system-graph.json`
6. **校验** → 报告（含 unresolved / 环 / 孤儿 / 跳过的未就绪服务）
7. **可视化/服务化**：见 §12（v0.1 仅产出 system-graph；dashboard 跨图跳转 + MCP 列 v1）

## 12. 可视化与消费

**已定：两个消费端都做** —— Dashboard 总览视图（给人）+ agent MCP（给 AI）。

- **Dashboard 总览视图**：渲染 `system-graph.json`，服务/业务域为节点，跨服务调用/业务流为边；点击节点/边按 `(graphRef,nodeId)` 键**跳转到对应服务 dashboard 的对应节点**（下钻）。
  - 现实约束：现有 dashboard 只渲染单张 `knowledge-graph.json`、不支持跨图跳转 → 需扩展 dashboard（v1 工作项）。v0.1 先产出合规的 `system-graph.json`，可用现有 dashboard 以"单图"方式查看总览。
- **agent MCP**：基于 registry 提供查询工具，如 `who_calls(service|key)`、`dependencies_of(service)`、`flows_in_domain(domain)`、`resolve_key(graphRef,nodeId)`（返回明细子图节点）。让 agent 先查总览再按键下钻、做分层检索。
- **与大平合并图并存**：已会做的"前缀化大平合并图"保留给"跨服务路径/影响面算法"场景，与本联邦方案互补、不冲突。

## 13. 决策（已拍板）

| # | 问题 | 决策 | 对设计的影响 |
|---|---|---|---|
| ① | 服务清单来源 | **手维护 manifest**；服务的**网关前缀/基路径由使用者在 manifest 中提供** | §0/§10：manifest 为唯一入口，含每服务 repo 路径、graphRef、域 ref、网关前缀/基路径、协议开关 |
| ② | 子图前提 | 服务**尚未全部**跑过 `/understand`，**后续慢慢补**；本技能只处理 manifest 中"已就绪"的服务，未就绪的**跳过并报告** | §11 阶段 0 做就绪校验；增量天然支持"补一个纳入一个" |
| ③ | 技术栈 | 以**本项目调研为基线**（§6.1）：Dubbo 主、HTTP raw、MQ 自封装、无 Feign/gRPC/Kafka；**其它服务的栈后续再补**，提取器按协议**插件化**便于扩展 | §6/§6.1/§10：v0.1 落 Dubbo + HTTP Provider；MQ 适配器待 topic 来源确认；新栈加插件 |
| ④ | 领域来源 | 各服务**必须**有 `domain-graph.json`；**缺失则报错提示使用者去补**（不启发式兜底） | §7 改为硬前置；§11 阶段 1 入口校验 |
| ⑤ | 存储 | **默认纯 JSON**；`manifest.registry.backend:"sqlite"` 可切 SQLite | §5.2/§9：抽象 registry 接口，双后端可换 |
| ⑥ | 消费形态 | **Dashboard 总览视图 + agent MCP**，两者都做 | §12：v0.1 出合规 system-graph；dashboard 跨图跳转 & MCP 列 v1 |
| ⑦ | 范围/LLM | **先走 v0.1 纯确定性骨架**，模糊残差只列 `unresolved`、不投 LLM | §14：v0.1 零 LLM |

### 已核对（实测 aurora 源码，v0.2 落地）
- **MQ topic 来源 → 确认为 Apollo 配置，源码内不存在**：`AbstractRocketMqHandler` 只有 `handleMessage(MessageExt)`，**无 `getTopic()`**；handler↔topic 绑定全在 Apollo（`mq.rocket-mq.handlerConfig` = tag→handler FQN、`consumeTopics`）。生产者 `MqSendService` 用具名方法 + `@Value("${mq.rocket-mq.producerTopic_*}")` 占位符，topic 值同样在 Apollo。
  → **结论**：源码侧只能确定性拿到「生产者 `@Value` 属性 key」与「消费者 handler FQN」；真实 topic 值由使用者在 manifest `mq.topics.byProp` / `mq.topics.byHandler` 提供（与"网关前缀由使用者提供"同性质，决策①）。提取器保留字面量/`getTopic()` 兜底以兼容其它服务；无映射时落 `topic:?` / `topicProp:KEY` 进 unresolved（R5），绝不猜。LLM 兜模糊残差留 v0.3。
- **fe service 模块请求约定 → 确认为高度规整**：`src/service/modules/*.js` 是 `{ name, url: `${host}/path`, method }` 描述符数组；`${host}`（`aurora`×161 / `sale` / `fourA` …，destructure 自 `process.env.API_HOST_LIST`）直接点名目标服务。
  → **结论**：HTTP Consumer 适配器可做。提取器剥掉 `${host}`，用 manifest 每个 fe 服务的 `http.hostMap`（`{aurora:"/aurora"}`）重建为 `VERB /aurora/path` 与后端 provider key 对齐；未映射的 host 保留裸路径 + `targetHint`，落 unresolved。置信度 0.5。
- **manifest 字段**：网关前缀/基路径为每服务一条（`http.basePath` / `http.gatewayPrefix`），已定稿；本次新增 `http.hostMap`、`mq.topics`。

## 14. 里程碑建议

- **v0.1（确定性骨架，零 LLM）★当前目标**：
  manifest + 就绪校验（缺 kg/domain 即跳过提示）→ **Dubbo 边界**（核心）+ **HTTP Provider 路由** → JSON registry → `(kind,key)` join → 系统图（服务/域节点 + 跨服务调用边**带 domain 标签** + flow 骨架）→ 校验 + unresolved 报告。可增量。
  **即交付 R1 的主干（调用框架 × 业务领域已在同一条边上交叉）+ R2 + R3。** 因 `domain-graph.json` 为硬前置，领域归属是确定性的，故 v0.1 即纳入（不再单列 v0.2）。
- **v0.2（提取器补全）**：MQ 适配器（确认 topic 来源后）；fe→backend HTTP Consumer 适配器；增量 diff 报告（新增/消失的跨服务边）。
- **v0.3（残差与规模化）✅ 已落地**：raw-URL/topic 模糊残差的 LLM 兜底（**按需开**，`--llm-residual`：`prepare-residual` 确定性预筛候选 → `residual-matcher` agent 从候选小集里挑一个或弃选 → `merge-residual` 校验后折成 `via:"llm"` 边，置信度封顶在确定性层之下）；SQLite registry 后端（`node:sqlite`，与 JSON 同 join 结果）。200+ 真实服务实测与性能调优仍待真实环境。
- **v1（消费）**：dashboard 总览视图 + 跨图下钻；agent MCP 查询工具。
