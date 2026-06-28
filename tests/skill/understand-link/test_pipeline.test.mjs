import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(__dirname, '../../../understand-anything-plugin/skills/understand-link');

function run(script, args) {
  return spawnSync('node', [join(SKILL, script), ...args], { encoding: 'utf-8' });
}

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

function writeFile(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Minimal but valid knowledge-graph.json with the given file node ids. */
function kg(fileIds) {
  return {
    version: '1.0.0',
    project: { name: 'svc', languages: ['java'], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
    nodes: fileIds.map((id) => ({ id, type: 'file', name: id, filePath: id.slice(5), summary: '', tags: [], complexity: 'simple' })),
    edges: [],
    layers: [],
    tour: [],
  };
}

/** Minimal domain-graph.json with one domain node. */
function domainGraph(name) {
  return {
    version: '1.0.0',
    project: { name: 'svc', languages: ['java'], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
    nodes: [{ id: `domain:${name}`, type: 'domain', name, summary: '', tags: [], complexity: 'simple' }],
    edges: [],
    layers: [],
    tour: [],
  };
}

let W; // workspace root
let LINK; // output dir

beforeAll(() => {
  W = mkdtempSync(join(tmpdir(), 'ua-link-'));
  LINK = join(W, '.understand-link');
  mkdirSync(join(LINK, 'intermediate'), { recursive: true });

  // --- aurora-service: Dubbo PROVIDER + HTTP provider, domain 派单 ---
  writeFile(
    join(W, 'aurora-service/src/main/java/DispatchPlanOpenServiceImpl.java'),
    `package com.hk.simba.aurora.service.impl;
import com.hk.simba.aurora.open.api.DispatchPlanOpenService;
import org.apache.dubbo.config.annotation.DubboService;

@DubboService
public class DispatchPlanOpenServiceImpl implements DispatchPlanOpenService {
  public String queryPlan(Long id) { return null; }
}
`,
  );
  writeFile(
    join(W, 'aurora-service/src/main/java/DispatchController.java'),
    `package com.hk.simba.aurora.controller;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/dispatch")
public class DispatchController {
  @PostMapping("/plan")
  public Object plan() { return null; }
}
`,
  );
  writeJson(
    join(W, 'aurora-service/.understand-anything/knowledge-graph.json'),
    kg(['file:src/main/java/DispatchPlanOpenServiceImpl.java', 'file:src/main/java/DispatchController.java']),
  );
  writeJson(join(W, 'aurora-service/.understand-anything/domain-graph.json'), domainGraph('派单'));

  // --- backend-aurora: Dubbo CONSUMER of aurora + an unresolved consume, domain 派单 ---
  writeFile(
    join(W, 'backend-aurora/src/main/java/DispatchPlanManager.java'),
    `package com.hk.simba.backend.manager;
import com.hk.simba.aurora.open.api.DispatchPlanOpenService;
import com.hk.simba.external.open.ExternalThingService;
import org.apache.dubbo.config.annotation.DubboReference;

public class DispatchPlanManager {
  @DubboReference private DispatchPlanOpenService dispatchPlanOpenService;
  @DubboReference private ExternalThingService externalThingService;
}
`,
  );
  writeJson(
    join(W, 'backend-aurora/.understand-anything/knowledge-graph.json'),
    kg(['file:src/main/java/DispatchPlanManager.java']),
  );
  writeJson(join(W, 'backend-aurora/.understand-anything/domain-graph.json'), domainGraph('派单'));

  // --- workorder-service: NOT ready (kg present, domain-graph MISSING) ---
  writeJson(
    join(W, 'workorder-service/.understand-anything/knowledge-graph.json'),
    kg(['file:src/main/java/Foo.java']),
  );

  // --- manifest (paths relative to manifest dir = W) ---
  writeJson(join(W, 'manifest.json'), {
    version: '1.0.0',
    registry: { backend: 'json' },
    services: [
      {
        serviceId: 'aurora-service', repo: 'aurora', root: 'aurora-service',
        graphRef: 'aurora-service/.understand-anything/knowledge-graph.json',
        domainRef: 'aurora-service/.understand-anything/domain-graph.json',
        http: { basePath: '/aurora', gatewayPrefix: '' },
      },
      {
        serviceId: 'backend-aurora', repo: 'aurora', root: 'backend-aurora',
        graphRef: 'backend-aurora/.understand-anything/knowledge-graph.json',
        domainRef: 'backend-aurora/.understand-anything/domain-graph.json',
        http: { basePath: '/backend-aurora', gatewayPrefix: '' },
      },
      {
        serviceId: 'workorder-service', repo: 'workorder', root: 'workorder-service',
        graphRef: 'workorder-service/.understand-anything/knowledge-graph.json',
        domainRef: 'workorder-service/.understand-anything/domain-graph.json',
      },
    ],
  });
});

afterAll(() => {
  if (W) rmSync(W, { recursive: true, force: true });
});

describe('understand-link full pipeline', () => {
  const readinessPath = () => join(LINK, 'intermediate/readiness.json');
  const boundariesDir = () => join(LINK, 'boundaries');
  const registryPath = () => join(LINK, 'registry.json');
  const crossPath = () => join(LINK, 'intermediate/cross-edges.json');
  const graphPath = () => join(LINK, 'system-graph.json');
  const reportPath = () => join(LINK, 'validation-report.json');

  it('phase 0: readiness skips the service missing domain-graph.json', () => {
    const r = run('check-readiness.mjs', [join(W, 'manifest.json'), readinessPath()]);
    expect(r.status).toBe(0);
    const readiness = JSON.parse(readFileSync(readinessPath(), 'utf-8'));
    expect(readiness.ready.sort()).toEqual(['aurora-service', 'backend-aurora']);
    expect(readiness.skipped.map((s) => s.serviceId)).toEqual(['workorder-service']);
    expect(readiness.skipped[0].reason).toMatch(/domain-graph\.json missing/);
    expect(readiness.skipped[0].hint).toMatch(/understand-domain/);
  });

  it('phase 1: extracts boundaries for ready services only', () => {
    const r = run('extract-boundaries.mjs', [readinessPath(), boundariesDir()]);
    expect(r.status).toBe(0);
    expect(existsSync(join(boundariesDir(), 'aurora-service.json'))).toBe(true);
    expect(existsSync(join(boundariesDir(), 'backend-aurora.json'))).toBe(true);
    expect(existsSync(join(boundariesDir(), 'workorder-service.json'))).toBe(false);

    const aurora = JSON.parse(readFileSync(join(boundariesDir(), 'aurora-service.json'), 'utf-8'));
    const dubboProvide = aurora.provides.find((p) => p.kind === 'dubbo');
    expect(dubboProvide.key).toBe('com.hk.simba.aurora.open.api.DispatchPlanOpenService');
    expect(dubboProvide.domain).toBe('派单');
    const httpProvide = aurora.provides.find((p) => p.kind === 'http');
    expect(httpProvide.key).toBe('POST /aurora/dispatch/plan');
    expect(aurora.stats.nodes).toBe(2);

    const backend = JSON.parse(readFileSync(join(boundariesDir(), 'backend-aurora.json'), 'utf-8'));
    expect(backend.consumes.map((c) => c.key).sort()).toEqual([
      'com.hk.simba.aurora.open.api.DispatchPlanOpenService',
      'com.hk.simba.external.open.ExternalThingService',
    ]);
  });

  it('phase 2: builds the registry', () => {
    const r = run('build-registry.mjs', [boundariesDir(), registryPath()]);
    expect(r.status).toBe(0);
    const reg = JSON.parse(readFileSync(registryPath(), 'utf-8'));
    expect(reg.services.map((s) => s.serviceId)).toEqual(['aurora-service', 'backend-aurora']);
    expect(reg.provides.length).toBeGreaterThanOrEqual(2);
    expect(reg.consumes.length).toBe(2);
    expect(reg.serviceDomains).toContainEqual({ serviceId: 'aurora-service', domain: '派单' });
  });

  it('phase 3: resolves one cross edge + one unresolved', () => {
    const r = run('resolve-cross-edges.mjs', [registryPath(), crossPath()]);
    expect(r.status).toBe(0);
    const out = JSON.parse(readFileSync(crossPath(), 'utf-8'));
    expect(out.crossEdges).toHaveLength(1);
    const e = out.crossEdges[0];
    expect(e).toMatchObject({
      type: 'calls', protocol: 'dubbo', domain: '派单',
      sourceService: 'backend-aurora', targetService: 'aurora-service',
      key: 'com.hk.simba.aurora.open.api.DispatchPlanOpenService',
    });
    expect(e.from.nodeId).toBe('file:src/main/java/DispatchPlanManager.java');
    expect(e.to.nodeId).toBe('file:src/main/java/DispatchPlanOpenServiceImpl.java');
    // ExternalThingService has no provider → unresolved (R5)
    expect(out.unresolved).toHaveLength(1);
    expect(out.unresolved[0].key).toBe('com.hk.simba.external.open.ExternalThingService');
  });

  it('phase 5: assembles the system graph (R1: call edge carries domain)', () => {
    const r = run('assemble-system-graph.mjs', [registryPath(), crossPath(), graphPath()]);
    expect(r.status).toBe(0);
    const g = JSON.parse(readFileSync(graphPath(), 'utf-8'));
    expect(g.services.map((s) => s.id)).toEqual(['aurora-service', 'backend-aurora']);
    expect(g.domains).toEqual([{ id: 'domain:派单', name: '派单', serviceIds: ['aurora-service', 'backend-aurora'] }]);

    const calls = g.edges.filter((e) => e.type === 'calls');
    expect(calls).toHaveLength(1);
    expect(calls[0].domain).toBe('派单'); // R1: topology × domain on the same edge

    const flows = g.edges.filter((e) => e.type === 'flow');
    expect(flows).toHaveLength(1);
    expect(flows[0].domain).toBe('派单');
    expect(flows[0].sequence).toEqual(['backend-aurora', 'aurora-service']);
    expect(flows[0].via).toEqual(['dubbo']);
    expect(g.unresolved).toHaveLength(1);
  });

  it('phase 6: validation passes and reports stats', () => {
    const r = run('validate-system-graph.mjs', [graphPath(), reportPath()]);
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(reportPath(), 'utf-8'));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.stats.services).toBe(2);
    expect(report.stats.callEdges).toBe(1);
    expect(report.stats.unresolved).toBe(1);
  });

  it('incremental: --changed skips unchanged services on re-run', () => {
    const r = run('extract-boundaries.mjs', [readinessPath(), boundariesDir(), '--changed']);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/2 unchanged/);
  });
});
