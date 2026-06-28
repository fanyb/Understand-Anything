#!/usr/bin/env node
/**
 * assemble-system-graph.mjs  —  Phase 5
 *
 * Assemble the Tier-0 federated system graph (DESIGN.md §5.3) from the registry
 * + the resolved cross-edges:
 *   - services[]: one node per service (domains, graphRef, stats)
 *   - domains[]:  one node per business domain (+ member serviceIds)
 *   - edges[]:    cross-service `calls` edges (each carrying `domain` so the call
 *                 topology and the business domain cross on the same edge — R1),
 *                 plus per-domain `flow` skeleton edges
 *   - unresolved[]: carried through from the join (R5)
 *
 * Usage:
 *   node assemble-system-graph.mjs <registry.json> <cross-edges.json> <system-graph.json>
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndexes } from './registry/json-store.mjs';

/** Pure: build the system graph document. */
export function assembleSystemGraph(reg, crossResult) {
  const { domainsByService } = buildIndexes(reg);

  const services = reg.services
    .map((s) => ({
      id: s.serviceId,
      repo: s.repo,
      domains: (domainsByService.get(s.serviceId) || []).slice().sort(),
      graphRef: s.graphRef,
      stats: s.stats || { nodes: 0, edges: 0 },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Domain nodes with their member services.
  const domainMembers = new Map();
  for (const d of reg.serviceDomains) {
    if (!domainMembers.has(d.domain)) domainMembers.set(d.domain, new Set());
    domainMembers.get(d.domain).add(d.serviceId);
  }
  const domains = [...domainMembers.entries()]
    .map(([name, set]) => ({
      id: `domain:${name}`,
      name,
      serviceIds: [...set].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const callEdges = crossResult.crossEdges || [];

  // Flow skeleton (DESIGN.md §7.3): per domain, the ordered sequence of services
  // touched by its cross-service calls, plus the protocols used. Skeleton only —
  // LLM naming/ordering is deferred (v0.3).
  const flowByDomain = new Map();
  for (const e of callEdges) {
    if (!e.domain) continue;
    if (!flowByDomain.has(e.domain)) flowByDomain.set(e.domain, { seq: [], via: new Set() });
    const f = flowByDomain.get(e.domain);
    for (const svc of [e.sourceService, e.targetService]) {
      if (!f.seq.includes(svc)) f.seq.push(svc);
    }
    f.via.add(e.protocol);
  }
  const flowEdges = [...flowByDomain.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, f], i) => ({
      id: `f${i + 1}`,
      type: 'flow',
      domain,
      sequence: f.seq,
      via: [...f.via].sort(),
    }));

  return {
    version: '1.0.0',
    kind: 'system',
    services,
    domains,
    edges: [...callEdges, ...flowEdges],
    unresolved: crossResult.unresolved || [],
  };
}

function main() {
  const [, , registryPath, crossEdgesPath, outputPath] = process.argv;
  if (!registryPath || !crossEdgesPath || !outputPath) {
    process.stderr.write(
      'Usage: node assemble-system-graph.mjs <registry.json> <cross-edges.json> <system-graph.json>\n',
    );
    process.exit(1);
  }
  const reg = JSON.parse(readFileSync(registryPath, 'utf-8'));
  const crossResult = JSON.parse(readFileSync(crossEdgesPath, 'utf-8'));
  const graph = assembleSystemGraph(reg, crossResult);
  writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf-8');
  process.stderr.write(
    `Info: understand-link: system graph — ${graph.services.length} services, ` +
      `${graph.domains.length} domains, ${graph.edges.length} edges, ` +
      `${graph.unresolved.length} unresolved.\n`,
  );
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
    process.stderr.write(`assemble-system-graph.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
