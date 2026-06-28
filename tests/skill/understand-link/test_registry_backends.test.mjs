import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(__dirname, '../../../understand-anything-plugin/skills/understand-link');

const jsonStore = await import(resolve(SKILL, 'registry/json-store.mjs'));
const registry = await import(resolve(SKILL, 'registry/index.mjs'));
const { buildRegistry } = await import(resolve(SKILL, 'build-registry.mjs'));
const { resolveCrossEdges } = await import(resolve(SKILL, 'resolve-cross-edges.mjs'));

const sqliteAvailable = await (async () => {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

// Two services that form one cross edge: workorder consumes aurora's dubbo provide.
const BOUNDARIES = [
  {
    serviceId: 'aurora-service',
    repo: 'aurora',
    graphRef: 'aurora/.understand-anything/knowledge-graph.json',
    domainRef: 'aurora/.understand-anything/domain-graph.json',
    sourceHash: 'sha256:a',
    domains: ['派单'],
    stats: { nodes: 3, edges: 5 },
    provides: [
      { kind: 'dubbo', key: 'com.x.DispatchOpenService', nodeId: 'file:Impl.java', domain: '派单', confidence: 1.0, evidence: '@DubboService' },
    ],
    consumes: [],
  },
  {
    serviceId: 'workorder-service',
    repo: 'workorder',
    graphRef: 'workorder/.understand-anything/knowledge-graph.json',
    domainRef: 'workorder/.understand-anything/domain-graph.json',
    sourceHash: 'sha256:b',
    domains: ['工单'],
    stats: { nodes: 2, edges: 1 },
    provides: [],
    consumes: [
      { kind: 'dubbo', key: 'com.x.DispatchOpenService', nodeId: 'file:Mgr.java', confidence: 1.0, evidence: '@DubboReference' },
    ],
  },
];

let W;
beforeAll(() => {
  W = mkdtempSync(join(tmpdir(), 'ua-link-reg-'));
});
afterAll(() => {
  if (W) rmSync(W, { recursive: true, force: true });
});

describe('registry factory', () => {
  it('getStore returns json by default and for "json"', async () => {
    expect(await registry.getStore()).toBe(jsonStore);
    expect(await registry.getStore('json')).toBe(jsonStore);
  });

  it('getStore rejects an unknown backend', async () => {
    await expect(registry.getStore('mongo')).rejects.toThrow(/unknown registry backend/);
  });

  it('re-exports the shared doc utilities', () => {
    expect(typeof registry.emptyRegistry).toBe('function');
    expect(typeof registry.buildIndexes).toBe('function');
    expect(typeof registry.indexKey).toBe('function');
  });
});

describe('json backend load/save round-trip', () => {
  it('save then load reproduces the registry document', () => {
    const reg = buildRegistry(BOUNDARIES, jsonStore.emptyRegistry());
    const path = join(W, 'registry.json');
    jsonStore.save(path, reg);
    const back = jsonStore.load(path);
    expect(back).toEqual(reg);
  });

  it('load of a missing file yields an empty registry', () => {
    expect(jsonStore.load(join(W, 'nope.json'))).toEqual(jsonStore.emptyRegistry());
  });
});

describe.skipIf(!sqliteAvailable)('sqlite backend parity with json', () => {
  it('round-trips rows and produces identical cross-edges', async () => {
    const sqlite = await registry.getStore('sqlite');
    const reg = buildRegistry(BOUNDARIES, jsonStore.emptyRegistry());

    const dbPath = join(W, 'registry.db');
    sqlite.save(dbPath, reg);
    const fromSql = sqlite.load(dbPath);

    // Rows survive the round-trip identically (backend label aside).
    expect(fromSql.services).toEqual(reg.services);
    expect(fromSql.provides).toEqual(reg.provides);
    expect(fromSql.consumes).toEqual(reg.consumes);
    expect(fromSql.serviceDomains).toEqual(reg.serviceDomains);
    expect(fromSql.backend).toBe('sqlite');

    // The join is backend-agnostic: same edges from the json doc and the sqlite doc.
    const jsonPath = join(W, 'parity.json');
    jsonStore.save(jsonPath, reg);
    const fromJson = jsonStore.load(jsonPath);
    expect(resolveCrossEdges(fromSql).crossEdges).toEqual(resolveCrossEdges(fromJson).crossEdges);
  });

  it('save is a full replace (re-saving a smaller doc shrinks the tables)', async () => {
    const sqlite = await registry.getStore('sqlite');
    const dbPath = join(W, 'replace.db');
    sqlite.save(dbPath, buildRegistry(BOUNDARIES, jsonStore.emptyRegistry()));
    expect(sqlite.load(dbPath).services).toHaveLength(2);

    sqlite.save(dbPath, buildRegistry([BOUNDARIES[0]], jsonStore.emptyRegistry()));
    const after = sqlite.load(dbPath);
    expect(after.services).toHaveLength(1);
    expect(after.consumes).toHaveLength(0);
  });

  it('the CLIs accept --backend=sqlite and resolve cross-edges from the .db', () => {
    const dir = join(W, 'boundaries-cli');
    mkdirSync(dir, { recursive: true });
    for (const b of BOUNDARIES) writeFileSync(join(dir, `${b.serviceId}.json`), JSON.stringify(b));
    const db = join(W, 'cli.db');
    const cross = join(W, 'cli-cross.json');

    const r1 = spawnSync('node', [join(SKILL, 'build-registry.mjs'), dir, db, '--backend=sqlite'], { encoding: 'utf-8' });
    expect(r1.status).toBe(0);
    const r2 = spawnSync('node', [join(SKILL, 'resolve-cross-edges.mjs'), db, cross, '--backend=sqlite'], { encoding: 'utf-8' });
    expect(r2.status).toBe(0);

    const out = JSON.parse(readFileSync(cross, 'utf-8'));
    expect(out.crossEdges).toHaveLength(1);
    expect(out.crossEdges[0]).toMatchObject({
      protocol: 'dubbo', sourceService: 'workorder-service', targetService: 'aurora-service', domain: '派单',
    });

    // Phase 5 (assemble) must also read the registry through the backend factory.
    const graphPath = join(W, 'cli-system.json');
    const r3 = spawnSync('node', [join(SKILL, 'assemble-system-graph.mjs'), db, cross, graphPath, '--backend=sqlite'], { encoding: 'utf-8' });
    expect(r3.status).toBe(0);
    const g = JSON.parse(readFileSync(graphPath, 'utf-8'));
    expect(g.services.map((s) => s.id)).toEqual(['aurora-service', 'workorder-service']);
    expect(g.edges.filter((e) => e.type === 'calls')).toHaveLength(1);
  });
});
