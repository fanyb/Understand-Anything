#!/usr/bin/env node
/**
 * validate-system-graph.mjs  —  Phase 6
 *
 * Validate the assembled system graph and produce a report (DESIGN.md §11.6):
 *   errors   — structural problems that make the graph invalid (exit 1)
 *   warnings — quality signals that don't block (orphans, cycles, low confidence)
 *   stats    — counts incl. unresolved (R5 observability)
 *
 * Usage:
 *   node validate-system-graph.mjs <system-graph.json> [report.json]
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Detect cycles in the service-level `calls` graph (Tarjan-free DFS). */
function findCycles(callEdges, serviceIds) {
  const adj = new Map(serviceIds.map((s) => [s, []]));
  for (const e of callEdges) {
    if (adj.has(e.sourceService)) adj.get(e.sourceService).push(e.targetService);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(serviceIds.map((s) => [s, WHITE]));
  const cycles = [];
  const stack = [];

  const dfs = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        cycles.push(stack.slice(idx).concat(v));
      } else if (color.get(v) === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const s of serviceIds) if (color.get(s) === WHITE) dfs(s);
  return cycles;
}

/** Pure: validate a system graph document → {ok, errors, warnings, stats}. */
export function validateSystemGraph(graph) {
  const errors = [];
  const warnings = [];

  if (!graph || typeof graph !== 'object') {
    return { ok: false, errors: ['graph is not an object'], warnings: [], stats: {} };
  }
  if (!Array.isArray(graph.services)) errors.push('missing "services" array');
  if (!Array.isArray(graph.edges)) errors.push('missing "edges" array');

  const serviceIds = new Set((graph.services || []).map((s) => s.id));
  const callEdges = (graph.edges || []).filter((e) => e.type === 'calls');
  const flowEdges = (graph.edges || []).filter((e) => e.type === 'flow');

  // Edge integrity: endpoints reference known services, keys point back to subgraphs.
  for (const e of callEdges) {
    if (!serviceIds.has(e.sourceService)) {
      errors.push(`edge ${e.id}: sourceService "${e.sourceService}" not in services[]`);
    }
    if (!serviceIds.has(e.targetService)) {
      errors.push(`edge ${e.id}: targetService "${e.targetService}" not in services[]`);
    }
    if (!e.from?.nodeId || !e.to?.nodeId) {
      errors.push(`edge ${e.id}: dangling key — from/to nodeId missing (breaks drill-down, R4)`);
    }
    if (!e.from?.graphRef || !e.to?.graphRef) {
      warnings.push(`edge ${e.id}: missing graphRef on one endpoint`);
    }
    if (typeof e.confidence === 'number' && e.confidence < 0.7) {
      warnings.push(`edge ${e.id}: low confidence ${e.confidence} (${e.protocol} ${e.key})`);
    }
  }

  // Domain membership references known services.
  for (const d of graph.domains || []) {
    for (const sid of d.serviceIds || []) {
      if (!serviceIds.has(sid)) {
        warnings.push(`domain "${d.name}": references unknown service "${sid}"`);
      }
    }
  }

  // Orphan services: no inbound or outbound cross-service edge.
  const connected = new Set();
  for (const e of callEdges) {
    connected.add(e.sourceService);
    connected.add(e.targetService);
  }
  const orphans = [...serviceIds].filter((s) => !connected.has(s));
  for (const o of orphans) {
    warnings.push(`service "${o}": no cross-service edges (orphan — isolated or all deps external)`);
  }

  // Cycles (reported, not fatal).
  const cycles = findCycles(callEdges, [...serviceIds]);
  for (const c of cycles) {
    warnings.push(`call cycle: ${c.join(' → ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      services: serviceIds.size,
      domains: (graph.domains || []).length,
      callEdges: callEdges.length,
      flowEdges: flowEdges.length,
      unresolved: (graph.unresolved || []).length,
      orphans: orphans.length,
      cycles: cycles.length,
    },
  };
}

function main() {
  const [, , graphPath, reportPath] = process.argv;
  if (!graphPath) {
    process.stderr.write('Usage: node validate-system-graph.mjs <system-graph.json> [report.json]\n');
    process.exit(1);
  }
  const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
  const report = validateSystemGraph(graph);
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  const s = report.stats;
  process.stderr.write(
    `understand-link validation: ${report.ok ? 'PASS' : 'FAIL'} — ` +
      `${s.services} services, ${s.callEdges} call edges, ${s.flowEdges} flows, ` +
      `${s.unresolved} unresolved, ${s.orphans} orphans, ${s.cycles} cycles.\n`,
  );
  for (const e of report.errors) process.stderr.write(`  ERROR: ${e}\n`);
  for (const w of report.warnings) process.stderr.write(`  warn:  ${w}\n`);

  if (!report.ok) process.exit(1);
}

function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`validate-system-graph.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
