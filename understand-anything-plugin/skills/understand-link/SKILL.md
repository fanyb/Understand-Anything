---
name: understand-link
description: Link multiple services' knowledge/domain graphs into one federated system graph — cross-service Dubbo/HTTP calls plus business-domain attribution, with stable keys back to each subgraph. Use when you have several /understand'd repos and need the system-level "who calls whom across services" view.
argument-hint: ["[manifest-path] [--changed]"]
---

# /understand-link

Relate **N already-analyzed services** into a single **federated system graph**
(`system-graph.json`): services + business domains as nodes, cross-service
Dubbo/HTTP calls + per-domain flows as edges, every cross-service edge carrying a
stable `(graphRef, nodeId)` key back into the per-service subgraph for drill-down.

This skill **consumes** the output of `/understand` and `/understand-domain` — it
never re-analyzes a service. See `DESIGN.md` (next to this file) for the full
rationale (federated two-tier + boundary registry, DESIGN.md §4).

## Scope (v0.2 — deterministic, zero LLM)

- **Extractors:**
  - **Dubbo** — `@DubboService`+`implements` (provider) / `@DubboReference` (consumer).
  - **HTTP** — Spring-MVC `@*Mapping` **provider** routes (normalized via the
    manifest's gateway prefix / base path) **and** fe→backend **consumer** calls
    (`axios.<verb>('/url')` in any frontend file; service-module `{ url, method }`
    config objects under `src/service/modules/*`-style paths). fe consumers are
    low-confidence (0.5) and miss gracefully into `unresolved`.
  - **MQ** — self-wrapped RocketMQ: `MqSendService.send("TOPIC", …)` (producer) /
    `extends AbstractRocketMqHandler` with `getTopic()`/`super(…)` (consumer).
    Topics are resolved from string literals + in-file `final String` constants;
    runtime/config-sourced topics surface as `topic:?` in `unresolved` (R5). Base /
    send class names are per-service configurable (`mq.consumerBaseClass` /
    `mq.producerClass`) for services that wrap RocketMQ under different names.
- **Incremental diff** — `diff-cross-edges.mjs` reports cross-edges added/removed
  between runs (DESIGN.md §14); see Phase 4b.
- **Registry backend** — `json` (default, git-diffable) or `sqlite` (real
  `node:sqlite` file for scale / SQL access), selected by manifest
  `registry.backend`. Both yield identical cross-edges (DESIGN.md §5.2).
- **Deferred (by design, DESIGN.md §14):** LLM residual matching (raw-URL /
  config-sourced topics) → v0.3; dashboard cross-graph drill-down + agent MCP → v1.

All phases are deterministic Node scripts — no subagents, no LLM.

## Options

`$ARGUMENTS` may contain:
- A path to the manifest file (a non-flag token). Defaults to
  `understand-link.manifest.json` then `manifest.json` in the current directory.
- `--changed` — incremental: re-extract only services whose source hash changed
  (DESIGN.md §8). Other phases are cheap and always re-run.

The **manifest is the single entry point** (DESIGN.md §13 decision ①). It is
hand-maintained — see `manifest.schema.json` and `manifest.example.json` in this
directory. Each service entry gives its `serviceId`, source `root`, the paths to
its `knowledge-graph.json` (`graphRef`) and `domain-graph.json` (`domainRef`),
and the HTTP `basePath` / `gatewayPrefix` the static scan cannot infer.

---

## Phase 0 — Pre-flight

1. **Resolve the skill directory** (for the bundled scripts). The scripts are
   self-contained (they do **not** import `@understand-anything/core`), so no
   build step is required.

   ```bash
   SKILL_REAL=$(realpath ~/.agents/skills/understand-link 2>/dev/null || readlink -f ~/.agents/skills/understand-link 2>/dev/null || echo "")
   SELF_RELATIVE=$([ -n "$SKILL_REAL" ] && cd "$SKILL_REAL/../.." 2>/dev/null && pwd || echo "")
   COPILOT_SKILL_REAL=$(realpath ~/.copilot/skills/understand-link 2>/dev/null || readlink -f ~/.copilot/skills/understand-link 2>/dev/null || echo "")
   COPILOT_SELF_RELATIVE=$([ -n "$COPILOT_SKILL_REAL" ] && cd "$COPILOT_SKILL_REAL/../.." 2>/dev/null && pwd || echo "")

   PLUGIN_ROOT=""
   for candidate in \
     "${CLAUDE_PLUGIN_ROOT}" \
     "$HOME/.understand-anything-plugin" \
     "$SELF_RELATIVE" \
     "$COPILOT_SELF_RELATIVE" \
     "$HOME/.codex/understand-anything/understand-anything-plugin" \
     "$HOME/.opencode/understand-anything/understand-anything-plugin" \
     "$HOME/.pi/understand-anything/understand-anything-plugin" \
     "$HOME/understand-anything/understand-anything-plugin"; do
     if [ -n "$candidate" ] && [ -f "$candidate/package.json" ] && [ -f "$candidate/pnpm-workspace.yaml" ]; then
       PLUGIN_ROOT="$candidate"
       break
     fi
   done
   if [ -z "$PLUGIN_ROOT" ]; then
     echo "Error: cannot find the understand-anything plugin root."
     exit 1
   fi
   SKILL_DIR="$PLUGIN_ROOT/skills/understand-link"
   ```

2. **Resolve the manifest.** Use the `$ARGUMENTS` path if given; else the first
   that exists of `./understand-link.manifest.json`, `./manifest.json`. If none
   exists, tell the user to create one from `$SKILL_DIR/manifest.example.json`
   and **STOP**.

3. **Set up the output workspace** under the manifest's directory:
   ```bash
   WORKSPACE_DIR="$(cd "$(dirname "$MANIFEST")" && pwd)"
   LINK_DIR="$WORKSPACE_DIR/.understand-link"
   mkdir -p "$LINK_DIR/intermediate" "$LINK_DIR/boundaries"
   ```

---

## Phase 1 — Readiness check (DESIGN.md §11.0)

Verify every manifest service has BOTH `knowledge-graph.json` and
`domain-graph.json`. Missing graphs are **hard prerequisites** — the service is
skipped and reported, never inferred (decision ②④).

```bash
node "$SKILL_DIR/check-readiness.mjs" "$MANIFEST" "$LINK_DIR/intermediate/readiness.json"
```

Relay the skipped services to the user verbatim (each line tells them which
service needs `/understand` and/or `/understand-domain`, and where). Continue
with whatever is ready — backfilling one service and re-running picks it up.

## Phase 2 — Boundary extraction (DESIGN.md §11.1)

For each ready service, scan its source and write `boundaries/<serviceId>.json`.

```bash
node "$SKILL_DIR/extract-boundaries.mjs" \
  "$LINK_DIR/intermediate/readiness.json" "$LINK_DIR/boundaries" $CHANGED_FLAG
```

(`CHANGED_FLAG` is `--changed` when the user passed it, else empty.)

## Phase 3 — Build the registry (DESIGN.md §11.2)

The backend is the manifest's `registry.backend` (`json` default, `sqlite`
optional — DESIGN.md §5.2 / decision ⑤). For `sqlite`, pass `--backend=sqlite`
and a `.db` path; both backends yield identical cross-edges.

```bash
BACKEND=$(node -e 'try{const m=require(process.argv[1]);process.stdout.write((m.registry&&m.registry.backend)||"json")}catch{process.stdout.write("json")}' "$MANIFEST")
REGISTRY="$LINK_DIR/registry.json"; [ "$BACKEND" = "sqlite" ] && REGISTRY="$LINK_DIR/registry.db"
node "$SKILL_DIR/build-registry.mjs" "$LINK_DIR/boundaries" "$REGISTRY" --backend="$BACKEND"
```

## Phase 4 — Resolve cross-service edges (DESIGN.md §11.3)

`(kind,key)` hash join → cross edges + `unresolved` (consumers with no known
provider — surfaced, never dropped, R5).

Before regenerating, snapshot the previous result so Phase 4b can diff it:

```bash
CROSS="$LINK_DIR/intermediate/cross-edges.json"
[ -f "$CROSS" ] && cp "$CROSS" "$LINK_DIR/intermediate/cross-edges.prev.json"
node "$SKILL_DIR/resolve-cross-edges.mjs" "$REGISTRY" "$CROSS" --backend="$BACKEND"
```

## Phase 4b — Incremental diff (optional; DESIGN.md §14)

On a re-run, report which cross-service edges appeared or disappeared since the
last run (pairs naturally with `--changed`). Skip on the first run (no snapshot).

```bash
PREV="$LINK_DIR/intermediate/cross-edges.prev.json"
[ -f "$PREV" ] && node "$SKILL_DIR/diff-cross-edges.mjs" \
  "$PREV" "$LINK_DIR/intermediate/cross-edges.json" "$LINK_DIR/intermediate/cross-edges.diff.json"
```

## Phase 5 — Assemble the system graph (DESIGN.md §11.5)

```bash
node "$SKILL_DIR/assemble-system-graph.mjs" \
  "$LINK_DIR/registry.json" "$LINK_DIR/intermediate/cross-edges.json" \
  "$LINK_DIR/system-graph.json"
```

## Phase 6 — Validate (DESIGN.md §11.6)

```bash
node "$SKILL_DIR/validate-system-graph.mjs" \
  "$LINK_DIR/system-graph.json" "$LINK_DIR/validation-report.json"
```

A non-zero exit means structural errors (dangling keys, edges to unknown
services). Warnings (orphan services, call cycles, low-confidence/unresolved) are
informational.

## Phase 7 — Report

Summarize for the user from `validation-report.json` and `system-graph.json`:
- services linked / skipped, cross-service edges by protocol, flows per domain;
- the `unresolved` list (likely external / unmanaged services);
- where the output is: `$LINK_DIR/system-graph.json`.

**Viewing:** the current dashboard renders a single `knowledge-graph.json` and
does not yet support cross-graph drill-down (a v1 work item). `system-graph.json`
is a standalone artifact; for now inspect it directly or load it as a single
graph. Each cross-service edge's `from`/`to` `(graphRef, nodeId)` points at the
exact node in a service's own graph for manual drill-down.
