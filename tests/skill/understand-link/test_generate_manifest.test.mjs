import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(__dirname, '../../../understand-anything-plugin/skills/understand-link');
const { discoverServices, buildManifest } = await import(resolve(SKILL, 'generate-manifest.mjs'));

function run(args) {
  return spawnSync('node', [join(SKILL, 'generate-manifest.mjs'), ...args], { encoding: 'utf-8' });
}

/** Lay down a service dir with a knowledge-graph.json and, optionally, a domain-graph.json. */
function makeService(root, hasDomain) {
  mkdirSync(join(root, '.understand-anything'), { recursive: true });
  writeFileSync(join(root, '.understand-anything/knowledge-graph.json'), '{"nodes":[],"edges":[]}');
  if (hasDomain) writeFileSync(join(root, '.understand-anything/domain-graph.json'), '{"nodes":[],"edges":[]}');
}

let W;

beforeAll(() => {
  W = mkdtempSync(join(tmpdir(), 'ua-genman-'));
  makeService(join(W, 'aurora-service'), true);          // both graphs
  makeService(join(W, 'backend-aurora'), false);         // missing domain-graph
  makeService(join(W, 'nested/workorder-service'), true); // one level deeper
  // A non-service dir and a vendor dir that must be ignored.
  mkdirSync(join(W, 'docs'), { recursive: true });
  makeService(join(W, 'node_modules/should-be-skipped'), true);
});

afterAll(() => rmSync(W, { recursive: true, force: true }));

describe('discoverServices', () => {
  it('finds every dir owning a knowledge-graph.json and flags domain presence', () => {
    const found = discoverServices(W);
    const byBase = Object.fromEntries(found.map((f) => [f.dir.split('/').pop(), f.hasDomain]));
    expect(byBase['aurora-service']).toBe(true);
    expect(byBase['backend-aurora']).toBe(false);
    expect(byBase['workorder-service']).toBe(true);
  });

  it('skips vendor/build dirs (node_modules)', () => {
    const found = discoverServices(W);
    expect(found.some((f) => f.dir.includes('node_modules'))).toBe(false);
  });

  it('respects max-depth (workorder-service is one level too deep at depth 1)', () => {
    const found = discoverServices(W, { maxDepth: 1 });
    expect(found.some((f) => f.dir.endsWith('workorder-service'))).toBe(false);
    expect(found.some((f) => f.dir.endsWith('aurora-service'))).toBe(true);
  });
});

describe('buildManifest', () => {
  it('emits relative graphRef/domainRef and blank http scaffolding', () => {
    const found = discoverServices(W);
    const { manifest } = buildManifest(found, W);
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.registry).toEqual({ backend: 'json' });
    const aurora = manifest.services.find((s) => s.serviceId === 'aurora-service');
    expect(aurora.root).toBe('aurora-service');
    expect(aurora.graphRef).toBe('aurora-service/.understand-anything/knowledge-graph.json');
    expect(aurora.domainRef).toBe('aurora-service/.understand-anything/domain-graph.json');
    expect(aurora.http).toEqual({ basePath: '', gatewayPrefix: '' });
  });

  it('de-duplicates colliding serviceIds by prefixing the parent dir name', () => {
    const found = [
      { dir: '/x/a/service', hasDomain: true },
      { dir: '/x/b/service', hasDomain: true },
    ];
    const { manifest } = buildManifest(found, '/x');
    const ids = manifest.services.map((s) => s.serviceId).sort();
    expect(ids).toEqual(['a-service', 'b-service']);
  });

  it('surfaces missing-domain services in the returned summary', () => {
    const found = discoverServices(W);
    const { services } = buildManifest(found, W);
    const backend = services.find((s) => s.serviceId === 'backend-aurora');
    expect(backend.hasDomain).toBe(false);
  });
});

describe('CLI', () => {
  it('writes a valid manifest and lists services on stderr', () => {
    const out = join(W, 'understand-link.manifest.json');
    const res = run([W, out]);
    expect(res.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const manifest = JSON.parse(readFileSync(out, 'utf-8'));
    expect(manifest.services.length).toBeGreaterThanOrEqual(3);
    expect(res.stderr).toMatch(/backend-aurora.*no domain-graph\.json/);
    rmSync(out);
  });

  it('refuses to overwrite an existing manifest without --force', () => {
    const out = join(W, 'exists.manifest.json');
    writeFileSync(out, '{}');
    const res = run([W, out]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/refusing to overwrite/);
    expect(run([W, out, '--force']).status).toBe(0);
    rmSync(out);
  });

  it('exits 2 with a clear message when no analyzed service exists', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ua-empty-'));
    const res = run([empty, join(empty, 'm.json')]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/found no analyzed services/);
    rmSync(empty, { recursive: true, force: true });
  });
});
