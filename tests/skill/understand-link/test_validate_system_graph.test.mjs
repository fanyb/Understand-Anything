import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSystemGraph } from '../../../understand-anything-plugin/skills/understand-link/validate-system-graph.mjs';
// The dashboard reads system-graph.json through core's STRUCTURAL validator; this
// JS validator is the producer-side SEMANTIC/integrity one. They are deliberately
// disjoint (see DESIGN-multi-repo §5) — so we test each against its OWN rules, and
// only cross-check that the one canonical valid fixture satisfies BOTH.
// Imported from core's built dist (root `prepare` builds core); the package
// specifier isn't resolvable from tests/ since core isn't a root dependency.
import { validateSystemGraph as validateSystemGraphCore } from '../../../understand-anything-plugin/packages/core/dist/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/system-graph.valid.json'), 'utf-8'));
const clone = () => JSON.parse(JSON.stringify(VALID));

describe('validate-system-graph.mjs (semantic/integrity)', () => {
  it('passes the canonical valid fixture with no errors or warnings', () => {
    const r = validateSystemGraph(VALID);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.stats).toMatchObject({ services: 2, callEdges: 1, flowEdges: 1, orphans: 0, cycles: 0 });
  });

  it('errors when the services array is missing', () => {
    const g = clone();
    delete g.services;
    const r = validateSystemGraph(g);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/missing "services" array/);
  });

  it('errors when a call edge references an unknown service', () => {
    const g = clone();
    g.edges[0].targetService = 'ghost-service';
    const r = validateSystemGraph(g);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/targetService "ghost-service" not in services/);
  });

  it('errors on a dangling drill-down key (missing from/to nodeId)', () => {
    const g = clone();
    delete g.edges[0].from.nodeId;
    const r = validateSystemGraph(g);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/dangling key/);
  });

  it('only warns (does not error) on a null graphRef endpoint', () => {
    const g = clone();
    g.edges[0].from.graphRef = null;
    const r = validateSystemGraph(g);
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/missing graphRef/);
  });

  it('warns on low confidence', () => {
    const g = clone();
    g.edges[0].confidence = 0.5;
    const r = validateSystemGraph(g);
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/low confidence/);
  });

  it('warns on an orphan service (no cross-service edges)', () => {
    const g = clone();
    g.services.push({ id: 'lonely', repo: 'x', domains: [], graphRef: 'lonely/.understand-anything/knowledge-graph.json', stats: { nodes: 1, edges: 0 } });
    const r = validateSystemGraph(g);
    expect(r.warnings.join('\n')).toMatch(/service "lonely": no cross-service edges/);
    expect(r.stats.orphans).toBe(1);
  });

  it('warns when a domain references an unknown service', () => {
    const g = clone();
    g.domains[0].serviceIds.push('ghost');
    const r = validateSystemGraph(g);
    expect(r.warnings.join('\n')).toMatch(/references unknown service "ghost"/);
  });
});

describe('contract cross-check (both validators accept the same valid graph)', () => {
  it('the canonical fixture also passes core\'s structural validateSystemGraph', () => {
    const r = validateSystemGraphCore(VALID);
    expect(r.success).toBe(true);
    expect(r.fatal).toBeUndefined();
    expect(r.data?.services).toHaveLength(2);
    expect(r.data?.edges).toHaveLength(2);
  });
});
