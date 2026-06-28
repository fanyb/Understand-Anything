import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
function kg(fileIds) {
  return {
    version: '1.0.0',
    project: { name: 'svc', languages: [], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
    nodes: fileIds.map((id) => ({ id, type: 'file', name: id, filePath: id.slice(5), summary: '', tags: [], complexity: 'simple' })),
    edges: [], layers: [], tour: [],
  };
}
function domainGraph(name) {
  return {
    version: '1.0.0',
    project: { name: 'svc', languages: [], frameworks: [], description: '', analyzedAt: '', gitCommitHash: '' },
    nodes: [{ id: `domain:${name}`, type: 'domain', name, summary: '', tags: [], complexity: 'simple' }],
    edges: [], layers: [], tour: [],
  };
}

let W, LINK;

beforeAll(() => {
  W = mkdtempSync(join(tmpdir(), 'ua-link-v2-'));
  LINK = join(W, '.understand-link');
  mkdirSync(join(LINK, 'intermediate'), { recursive: true });

  // --- aurora-service: HTTP provider + MQ producer, domain 派单 ---
  writeFile(
    join(W, 'aurora-service/src/main/java/DispatchController.java'),
    `package c;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/dispatch")
public class DispatchController {
  @PostMapping("/plan") public Object plan() { return null; }
}
`,
  );
  writeFile(
    join(W, 'aurora-service/src/main/java/DispatchPublisher.java'),
    `package p;
public class DispatchPublisher {
  private MqSendService mqSendService;
  public void publish(Object evt) { mqSendService.send("DISPATCH_DONE", evt); }
}
`,
  );
  writeJson(
    join(W, 'aurora-service/.understand-anything/knowledge-graph.json'),
    kg(['file:src/main/java/DispatchController.java', 'file:src/main/java/DispatchPublisher.java']),
  );
  writeJson(join(W, 'aurora-service/.understand-anything/domain-graph.json'), domainGraph('派单'));

  // --- web-frontend: fe HTTP consumer of aurora + an unresolved call, domain 派单 ---
  writeFile(
    join(W, 'web-frontend/src/service/modules/dispatch.ts'),
    `export function plan(d){ return axios.post('/aurora/dispatch/plan', d); }
export function ext(){ return axios.get('/external/thing'); }
`,
  );
  writeJson(
    join(W, 'web-frontend/.understand-anything/knowledge-graph.json'),
    kg(['file:src/service/modules/dispatch.ts']),
  );
  writeJson(join(W, 'web-frontend/.understand-anything/domain-graph.json'), domainGraph('派单'));

  // --- notify-service: MQ consumer of aurora's topic, domain 通知 ---
  writeFile(
    join(W, 'notify-service/src/main/java/NotifyListener.java'),
    `package n;
public class NotifyListener extends AbstractRocketMqHandler {
  @Override public String getTopic() { return "DISPATCH_DONE"; }
}
`,
  );
  writeJson(
    join(W, 'notify-service/.understand-anything/knowledge-graph.json'),
    kg(['file:src/main/java/NotifyListener.java']),
  );
  writeJson(join(W, 'notify-service/.understand-anything/domain-graph.json'), domainGraph('通知'));

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
        serviceId: 'web-frontend', repo: 'web', root: 'web-frontend',
        graphRef: 'web-frontend/.understand-anything/knowledge-graph.json',
        domainRef: 'web-frontend/.understand-anything/domain-graph.json',
      },
      {
        serviceId: 'notify-service', repo: 'notify', root: 'notify-service',
        graphRef: 'notify-service/.understand-anything/knowledge-graph.json',
        domainRef: 'notify-service/.understand-anything/domain-graph.json',
      },
    ],
  });
});

afterAll(() => {
  if (W) rmSync(W, { recursive: true, force: true });
});

describe('understand-link v0.2 pipeline (MQ + fe HTTP consumer)', () => {
  const readinessPath = () => join(LINK, 'intermediate/readiness.json');
  const boundariesDir = () => join(LINK, 'boundaries');
  const registryPath = () => join(LINK, 'registry.json');
  const crossPath = () => join(LINK, 'intermediate/cross-edges.json');
  const graphPath = () => join(LINK, 'system-graph.json');

  it('runs phases 0–2 and extracts MQ + fe boundaries', () => {
    expect(run('check-readiness.mjs', [join(W, 'manifest.json'), readinessPath()]).status).toBe(0);
    expect(run('extract-boundaries.mjs', [readinessPath(), boundariesDir()]).status).toBe(0);
    expect(run('build-registry.mjs', [boundariesDir(), registryPath()]).status).toBe(0);

    const aurora = JSON.parse(readFileSync(join(boundariesDir(), 'aurora-service.json'), 'utf-8'));
    expect(aurora.provides.find((p) => p.kind === 'mq')).toMatchObject({ key: 'topic:DISPATCH_DONE', role: 'producer', domain: '派单' });
    expect(aurora.provides.find((p) => p.kind === 'http').key).toBe('POST /aurora/dispatch/plan');

    const web = JSON.parse(readFileSync(join(boundariesDir(), 'web-frontend.json'), 'utf-8'));
    expect(web.consumes.map((c) => c.key).sort()).toEqual(['GET /external/thing', 'POST /aurora/dispatch/plan']);

    const notify = JSON.parse(readFileSync(join(boundariesDir(), 'notify-service.json'), 'utf-8'));
    expect(notify.consumes).toMatchObject([{ kind: 'mq', key: 'topic:DISPATCH_DONE', role: 'consumer' }]);
  });

  it('resolves one http + one mq cross edge, one unresolved (R5)', () => {
    expect(run('resolve-cross-edges.mjs', [registryPath(), crossPath()]).status).toBe(0);
    const out = JSON.parse(readFileSync(crossPath(), 'utf-8'));

    expect(out.crossEdges).toHaveLength(2);
    const http = out.crossEdges.find((e) => e.protocol === 'http');
    expect(http).toMatchObject({
      sourceService: 'web-frontend', targetService: 'aurora-service',
      key: 'POST /aurora/dispatch/plan', domain: '派单',
    });
    expect(http.from.nodeId).toBe('file:src/service/modules/dispatch.ts');
    expect(http.to.nodeId).toBe('file:src/main/java/DispatchController.java');

    const mq = out.crossEdges.find((e) => e.protocol === 'mq');
    expect(mq).toMatchObject({
      sourceService: 'notify-service', targetService: 'aurora-service',
      key: 'topic:DISPATCH_DONE', domain: '派单', // domain comes from the producer side
    });

    // axios.get('/external/thing') has no provider → unresolved, not dropped.
    expect(out.unresolved.map((u) => u.key)).toEqual(['GET /external/thing']);
  });

  it('assembles + validates the system graph', () => {
    expect(run('assemble-system-graph.mjs', [registryPath(), crossPath(), graphPath()]).status).toBe(0);
    const g = JSON.parse(readFileSync(graphPath(), 'utf-8'));
    expect(g.services.map((s) => s.id)).toEqual(['aurora-service', 'notify-service', 'web-frontend']);
    expect(g.domains.map((d) => d.name)).toEqual(['派单', '通知']);
    expect(g.edges.filter((e) => e.type === 'calls')).toHaveLength(2);

    const flow = g.edges.find((e) => e.type === 'flow');
    expect(flow.domain).toBe('派单');
    expect(flow.via).toEqual(['http', 'mq']);

    const r = run('validate-system-graph.mjs', [graphPath(), join(LINK, 'validation-report.json')]);
    expect(r.status).toBe(0); // low-confidence fe edge is a warning, not an error
    const report = JSON.parse(readFileSync(join(LINK, 'validation-report.json'), 'utf-8'));
    expect(report.ok).toBe(true);
    expect(report.stats).toMatchObject({ services: 3, callEdges: 2, unresolved: 1 });
  });

  it('diff-cross-edges reports no change against an identical snapshot', () => {
    const snap = join(LINK, 'intermediate/cross-edges.prev.json');
    writeFileSync(snap, readFileSync(crossPath(), 'utf-8'));
    const diffPath = join(LINK, 'intermediate/diff.json');
    const r = run('diff-cross-edges.mjs', [snap, crossPath(), diffPath]);
    expect(r.status).toBe(0);
    const diff = JSON.parse(readFileSync(diffPath, 'utf-8'));
    expect(diff.stats).toMatchObject({ added: 0, removed: 0 });
  });
});
