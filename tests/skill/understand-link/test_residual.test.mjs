import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(__dirname, '../../../understand-anything-plugin/skills/understand-link');

const { tokens, rankCandidates, prepareResidual } = await import(resolve(SKILL, 'prepare-residual.mjs'));
const { mergeResidual } = await import(resolve(SKILL, 'merge-residual.mjs'));

// A small registry with three services. backend-aurora exposes two HTTP routes
// under the /aurora gateway prefix; aurora-service exposes a dubbo interface. The
// fe consume "POST /order/dispatch" is the residual: same resource as a provider
// route but under a different prefix, so the exact (kind,key) join missed it.
function fixtureRegistry() {
  return {
    version: '1.0.0',
    backend: 'json',
    services: [
      { serviceId: 'fe-aurora', repo: 'fe', graphRef: 'fe/kg.json', stats: { nodes: 1, edges: 0 } },
      { serviceId: 'backend-aurora', repo: 'backend', graphRef: 'backend/kg.json', stats: { nodes: 2, edges: 1 } },
      { serviceId: 'aurora-service', repo: 'aurora', graphRef: 'aurora/kg.json', stats: { nodes: 2, edges: 1 } },
    ],
    provides: [
      { serviceId: 'backend-aurora', kind: 'http', key: 'POST /aurora/order/dispatch', nodeId: 'file:OrderController.java', domain: '派单', confidence: 0.9, evidence: '@PostMapping' },
      { serviceId: 'backend-aurora', kind: 'http', key: 'POST /aurora/order/cancel', nodeId: 'file:OrderController.java', domain: '派单', confidence: 0.9, evidence: '@PostMapping' },
      { serviceId: 'aurora-service', kind: 'dubbo', key: 'com.x.DispatchOpenService', nodeId: 'file:Impl.java', domain: '调度', confidence: 1.0, evidence: '@DubboService' },
    ],
    consumes: [
      { serviceId: 'fe-aurora', kind: 'http', key: 'POST /order/dispatch', nodeId: 'file:src/service/modules/order.js', confidence: 0.5, evidence: 'axios.post(`${aurora}/order/dispatch`)', targetHint: 'aurora' },
    ],
    serviceDomains: [
      { serviceId: 'backend-aurora', domain: '派单' },
      { serviceId: 'aurora-service', domain: '调度' },
    ],
  };
}

const UNRESOLVED = {
  kind: 'http',
  key: 'POST /order/dispatch',
  consumerService: 'fe-aurora',
  nodeId: 'file:src/service/modules/order.js',
  reason: 'no provider in registry (likely external / unmanaged service)',
};

describe('tokens', () => {
  it('splits camelCase, lowercases, and drops non-alphanumerics', () => {
    expect(tokens('OrderDispatchHandler')).toEqual(['order', 'dispatch', 'handler']);
    expect(tokens('com.x.DispatchOpenService')).toEqual(['com', 'x', 'dispatch', 'open', 'service']);
    expect(tokens('topic:order_dispatch')).toEqual(['topic', 'order', 'dispatch']);
  });
});

describe('rankCandidates', () => {
  it('HTTP: requires same verb and rewards shared trailing path segments', () => {
    const reg = fixtureRegistry();
    const ranked = rankCandidates(UNRESOLVED, reg.consumes[0], reg.provides);
    // Only the /aurora/order/dispatch route shares a trailing segment; /cancel scores 0 and is dropped.
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ serviceId: 'backend-aurora', key: 'POST /aurora/order/dispatch' });
    expect(ranked[0].score).toBeGreaterThan(4); // suffix(2)*2 + jaccard
  });

  it('HTTP: a different verb never matches', () => {
    const reg = fixtureRegistry();
    const ranked = rankCandidates({ ...UNRESOLVED, key: 'GET /order/dispatch' }, reg.consumes[0], reg.provides);
    expect(ranked).toEqual([]);
  });

  it('never proposes a candidate from the consumer service itself', () => {
    const reg = fixtureRegistry();
    // Make backend-aurora consume its own route — it must not be its own candidate.
    reg.consumes.push({ serviceId: 'backend-aurora', kind: 'http', key: 'POST /order/dispatch', nodeId: 'file:Self.java' });
    const ranked = rankCandidates(
      { ...UNRESOLVED, consumerService: 'backend-aurora' },
      reg.consumes[1],
      reg.provides,
    );
    expect(ranked.every((c) => c.serviceId !== 'backend-aurora')).toBe(true);
  });

  it('MQ: scores token overlap between the consumer handler FQN and the topic', () => {
    const provides = [
      { serviceId: 'svc-a', kind: 'mq', key: 'topic:order_dispatch', nodeId: 'file:Pub.java' },
      { serviceId: 'svc-b', kind: 'mq', key: 'topic:user_login', nodeId: 'file:Pub2.java' },
    ];
    const u = { kind: 'mq', key: 'topic:?', consumerService: 'svc-c', nodeId: 'file:H.java' };
    const row = { handlerFqn: 'com.x.OrderDispatchHandler' };
    const ranked = rankCandidates(u, row, provides);
    expect(ranked[0].key).toBe('topic:order_dispatch'); // shares order+dispatch
  });

  it('respects the max-candidates cap', () => {
    const provides = Array.from({ length: 8 }, (_, i) => ({
      serviceId: `svc-${i}`, kind: 'http', key: `POST /a/dispatch`, nodeId: `file:C${i}.java`,
    }));
    const ranked = rankCandidates(UNRESOLVED, {}, provides, 3);
    expect(ranked).toHaveLength(3);
  });
});

describe('prepareResidual', () => {
  it('shortlists candidates and carries evidence/targetHint from the consume row', () => {
    const reg = fixtureRegistry();
    const crossResult = { crossEdges: [], unresolved: [UNRESOLVED] };
    const out = prepareResidual(reg, crossResult);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].unresolved).toMatchObject({
      key: 'POST /order/dispatch',
      consumerService: 'fe-aurora',
      targetHint: 'aurora',
      evidence: 'axios.post(`${aurora}/order/dispatch`)',
    });
    expect(out.entries[0].candidates[0].serviceId).toBe('backend-aurora');
    expect(out.stats).toMatchObject({ unresolvedTotal: 1, withCandidates: 1, emitted: 1, droppedNoCandidate: 0 });
  });

  it('drops unresolved entries that have no plausible candidate (stays unresolved)', () => {
    const reg = fixtureRegistry();
    const external = { kind: 'http', key: 'POST /external/thing', consumerService: 'fe-aurora', nodeId: 'file:x.js' };
    const out = prepareResidual(reg, { crossEdges: [], unresolved: [external] });
    expect(out.entries).toHaveLength(0);
    expect(out.stats).toMatchObject({ unresolvedTotal: 1, withCandidates: 0, emitted: 0, droppedNoCandidate: 1 });
  });

  it('caps emitted entries at maxEntries and reports the overflow', () => {
    const reg = fixtureRegistry();
    const unresolved = Array.from({ length: 5 }, (_, i) => ({
      kind: 'http', key: `POST /order/dispatch`, consumerService: `fe-${i}`, nodeId: `file:m${i}.js`,
    }));
    const out = prepareResidual(reg, { crossEdges: [], unresolved }, { maxEntries: 2 });
    expect(out.entries).toHaveLength(2);
    expect(out.stats).toMatchObject({ withCandidates: 5, emitted: 2, cappedOut: 3 });
  });
});

describe('mergeResidual', () => {
  const crossResult = () => ({
    crossEdges: [],
    unresolved: [UNRESOLVED],
    stats: { crossEdges: 0, unresolved: 1, byProtocol: {} },
  });
  const match = (over = {}) => ({
    matches: [
      {
        kind: 'http', key: 'POST /order/dispatch', consumerService: 'fe-aurora',
        nodeId: 'file:src/service/modules/order.js',
        chosen: { serviceId: 'backend-aurora', key: 'POST /aurora/order/dispatch' },
        confidence: 0.58, reason: 'same resource under aurora prefix', ...over,
      },
    ],
  });

  it('folds a confirmed pick into a via:"llm" edge and clears it from unresolved', () => {
    const reg = fixtureRegistry();
    const out = mergeResidual(reg, crossResult(), match());
    expect(out.crossEdges).toHaveLength(1);
    expect(out.crossEdges[0]).toMatchObject({
      type: 'calls', protocol: 'http', via: 'llm',
      sourceService: 'fe-aurora', targetService: 'backend-aurora',
      key: 'POST /aurora/order/dispatch', domain: '派单', confidence: 0.58,
    });
    // domain + drill-down keys come from the registry, not the agent.
    expect(out.crossEdges[0].from).toEqual({ graphRef: 'fe/kg.json', nodeId: 'file:src/service/modules/order.js' });
    expect(out.crossEdges[0].to).toEqual({ graphRef: 'backend/kg.json', nodeId: 'file:OrderController.java' });
    expect(out.unresolved).toHaveLength(0);
    expect(out.stats.llmResolved).toBe(1);
  });

  it('caps confidence below the deterministic tier', () => {
    const reg = fixtureRegistry();
    const out = mergeResidual(reg, crossResult(), match({ confidence: 0.95 }));
    expect(out.crossEdges[0].confidence).toBe(0.6);
  });

  it('ignores a null choice (declined) — the consume stays unresolved', () => {
    const reg = fixtureRegistry();
    const out = mergeResidual(reg, crossResult(), match({ chosen: null }));
    expect(out.crossEdges).toHaveLength(0);
    expect(out.unresolved).toHaveLength(1);
    expect(out.stats.llmResolved).toBe(0);
  });

  it('drops picks below minConfidence', () => {
    const reg = fixtureRegistry();
    const out = mergeResidual(reg, crossResult(), match({ confidence: 0.3 }));
    expect(out.crossEdges).toHaveLength(0);
    expect(out.unresolved).toHaveLength(1);
  });

  it('rejects a chosen provide that does not exist in the registry (agent only proposes)', () => {
    const reg = fixtureRegistry();
    const out = mergeResidual(reg, crossResult(), match({ chosen: { serviceId: 'backend-aurora', key: 'POST /nope' } }));
    expect(out.crossEdges).toHaveLength(0);
    expect(out.unresolved).toHaveLength(1);
  });

  it('does not duplicate an edge the deterministic join already produced', () => {
    const reg = fixtureRegistry();
    const base = crossResult();
    base.crossEdges.push({
      id: 'x1', type: 'calls', protocol: 'http', domain: '派单',
      sourceService: 'fe-aurora', targetService: 'backend-aurora', key: 'POST /aurora/order/dispatch',
      from: {}, to: {}, confidence: 0.5,
    });
    const out = mergeResidual(reg, base, match());
    expect(out.crossEdges).toHaveLength(1); // no second copy
    expect(out.stats.llmResolved).toBe(0);
  });
});
