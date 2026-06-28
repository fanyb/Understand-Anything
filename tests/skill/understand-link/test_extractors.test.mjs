import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, '../../../understand-anything-plugin/skills/understand-link/extractors');

const { scanJava, resolveFqn } = await import(resolve(EXT, 'java-scan.mjs'));
const dubbo = await import(resolve(EXT, 'dubbo.mjs'));
const http = await import(resolve(EXT, 'http.mjs'));
const mq = await import(resolve(EXT, 'mq.mjs'));
const { diffCrossEdges } = await import(resolve(EXT, '../diff-cross-edges.mjs'));

describe('java-scan', () => {
  it('extracts package, imports, annotated class with implements', () => {
    const src = `
package com.hk.simba.aurora.service.impl;

import com.hk.simba.aurora.open.api.DispatchPlanOpenService;
import org.apache.dubbo.config.annotation.DubboService;

@DubboService
public class DispatchPlanOpenServiceImpl implements DispatchPlanOpenService {
  public String queryPlan(Long id) { return null; }
}
`;
    const scan = scanJava(src);
    expect(scan.packageName).toBe('com.hk.simba.aurora.service.impl');
    expect(scan.imports.DispatchPlanOpenService).toBe('com.hk.simba.aurora.open.api.DispatchPlanOpenService');
    expect(scan.classes).toHaveLength(1);
    expect(scan.classes[0].name).toBe('DispatchPlanOpenServiceImpl');
    expect(scan.classes[0].implementsList).toEqual(['DispatchPlanOpenService']);
    expect(scan.classes[0].annotations.map((a) => a.name)).toContain('DubboService');
  });

  it('extracts @DubboReference fields', () => {
    const src = `
package x;
import com.hk.simba.workorder.open.WorkorderOpenService;
public class WorkorderManager {
  @DubboReference(check = false)
  private WorkorderOpenService workorderOpenService;
}
`;
    const scan = scanJava(src);
    expect(scan.fields).toHaveLength(1);
    expect(scan.fields[0].type).toBe('WorkorderOpenService');
    expect(scan.fields[0].annotations.map((a) => a.name)).toContain('DubboReference');
  });

  it('resolveFqn: import wins (1.0), then same-package (0.7), then bare (0.5)', () => {
    const scan = { imports: { Foo: 'a.b.Foo' }, packageName: 'p.q' };
    expect(resolveFqn('Foo', scan)).toEqual({ fqn: 'a.b.Foo', confidence: 1.0 });
    expect(resolveFqn('Bar', scan)).toEqual({ fqn: 'p.q.Bar', confidence: 0.7 });
    expect(resolveFqn('Baz', { imports: {}, packageName: '' })).toEqual({ fqn: 'Baz', confidence: 0.5 });
  });
});

describe('dubbo extractor', () => {
  it('provides the implemented interface FQN; consumes the @DubboReference type FQN', () => {
    const provider = {
      path: 'src/main/java/DispatchPlanOpenServiceImpl.java',
      content: `package impl;
import com.hk.simba.aurora.open.api.DispatchPlanOpenService;
@DubboService
public class DispatchPlanOpenServiceImpl implements DispatchPlanOpenService {}`,
    };
    const consumer = {
      path: 'src/main/java/WorkorderManager.java',
      content: `package mgr;
import com.hk.simba.workorder.open.WorkorderOpenService;
public class WorkorderManager {
  @DubboReference private WorkorderOpenService svc;
}`,
    };
    const out = dubbo.extract([provider, consumer], { serviceId: 'aurora', domains: ['派单'] });

    expect(out.provides).toHaveLength(1);
    expect(out.provides[0]).toMatchObject({
      kind: 'dubbo',
      key: 'com.hk.simba.aurora.open.api.DispatchPlanOpenService',
      nodeId: 'file:src/main/java/DispatchPlanOpenServiceImpl.java',
      domain: '派单',
      confidence: 1.0,
    });
    expect(out.consumes).toHaveLength(1);
    expect(out.consumes[0]).toMatchObject({
      kind: 'dubbo',
      key: 'com.hk.simba.workorder.open.WorkorderOpenService',
      nodeId: 'file:src/main/java/WorkorderManager.java',
      confidence: 1.0,
    });
  });

  it('omits domain when service owns multiple domains', () => {
    const out = dubbo.extract(
      [{ path: 'A.java', content: `package a; import x.IFace;\n@DubboService public class A implements IFace {}` }],
      { serviceId: 's', domains: ['派单', '仿真'] },
    );
    expect(out.provides[0].domain).toBeUndefined();
  });
});

describe('http extractor', () => {
  it('combines class base + method mapping + gateway prefix into a normalized key', () => {
    const file = {
      path: 'src/main/java/DispatchController.java',
      content: `package ctl;
@RestController
@RequestMapping("/dispatch")
public class DispatchController {
  @PostMapping("/plan")
  public Object queryPlan() { return null; }

  @GetMapping(value = "/status")
  public Object status() { return null; }
}`,
    };
    const out = http.extract([file], {
      serviceId: 'aurora',
      domains: ['派单'],
      http: { basePath: '/aurora', gatewayPrefix: '' },
    });
    const keys = out.provides.map((p) => p.key).sort();
    expect(keys).toEqual(['GET /aurora/dispatch/status', 'POST /aurora/dispatch/plan']);
    expect(out.provides[0]).toMatchObject({ kind: 'http', domain: '派单', nodeId: 'file:src/main/java/DispatchController.java' });
    expect(out.consumes).toEqual([]); // deferred to v0.2
  });

  it('parses @RequestMapping method= as the verb', () => {
    const file = {
      path: 'C.java',
      content: `package c;
@RestController
public class C {
  @RequestMapping(value = "/x", method = RequestMethod.PUT)
  public void x() {}
}`,
    };
    const out = http.extract([file], { http: {} });
    expect(out.provides[0].key).toBe('PUT /x');
  });

  it('normalizePath collapses slashes and strips trailing slash', () => {
    expect(http.normalizePath(['', '/aurora/', '/dispatch', 'plan/'])).toBe('/aurora/dispatch/plan');
    expect(http.normalizePath([])).toBe('/');
  });
});

describe('http fe→backend consumer extractor', () => {
  it('axios.<verb>(url) → http consume keyed VERB /path (query stripped)', () => {
    const out = http.extractFeConsumes(
      'src/service/modules/dispatch.ts',
      `export function plan(d){ return axios.post('/aurora/dispatch/plan', d); }
       export function status(){ return axios.get('/aurora/dispatch/status?id=1'); }`,
    );
    expect(out.map((c) => c.key).sort()).toEqual(['GET /aurora/dispatch/status', 'POST /aurora/dispatch/plan']);
    expect(out[0]).toMatchObject({ kind: 'http', nodeId: 'file:src/service/modules/dispatch.ts', confidence: 0.5 });
  });

  it('service-module { url, method } object → consume; method defaults GET', () => {
    const out = http.extractFeConsumes(
      'src/service/modules/order.ts',
      `const create = { url: '/order/create', method: 'post' };
       const list = { url: '/order/list' };`,
    );
    expect(out.map((c) => c.key).sort()).toEqual(['GET /order/list', 'POST /order/create']);
  });

  it('bare url: object is ignored outside an api/service-module path', () => {
    const out = http.extractFeConsumes('src/components/Banner.vue', `const img = { url: '/static/banner.png' };`);
    expect(out).toEqual([]);
  });

  it('resolves `${host}/path` via hostMap (real aurora shape); unmapped host keeps bare path + targetHint', () => {
    const content = `const { aurora, sale } = process.env.API_HOST_LIST
const list = [
  { name: 'A', url: \`\${aurora}/commonWhiteList/list\`, method: 'POST', withCredentials: true },
  { name: 'B', url: \`\${sale}/order/detail\`, method: 'GET' },
]`;
    const out = http.extractFeConsumes('src/service/modules/whiteList.js', content, { aurora: '/aurora' });
    const a = out.find((c) => c.key.includes('commonWhiteList'));
    expect(a.key).toBe('POST /aurora/commonWhiteList/list'); // ${aurora} → /aurora, method from same object
    const b = out.find((c) => c.targetHint === 'sale');
    expect(b).toMatchObject({ key: 'GET /order/detail', targetHint: 'sale' }); // unmapped → bare path + hint
  });

  it('integration: http.extract routes fe files to consumes, leaves provides empty', () => {
    const out = http.extract([{ path: 'src/api/user.ts', content: `axios.get('/user/me')` }], { http: {} });
    expect(out.provides).toEqual([]);
    expect(out.consumes).toHaveLength(1);
    expect(out.consumes[0].key).toBe('GET /user/me');
  });
});

describe('mq extractor', () => {
  it('producer .send("TOPIC") provides; consumer extends handler with getTopic() consumes', () => {
    const producer = {
      path: 'src/main/java/DispatchPublisher.java',
      content: `package p;
public class DispatchPublisher {
  private MqSendService mqSendService;
  public void publish(Object evt) { mqSendService.send("DISPATCH_DONE", evt); }
}`,
    };
    const consumer = {
      path: 'src/main/java/DispatchListener.java',
      content: `package p;
public class DispatchListener extends AbstractRocketMqHandler {
  @Override public String getTopic() { return "DISPATCH_DONE"; }
}`,
    };
    const out = mq.extract([producer, consumer], { serviceId: 's', domains: ['派单'] });

    expect(out.provides).toHaveLength(1);
    expect(out.provides[0]).toMatchObject({
      kind: 'mq', key: 'topic:DISPATCH_DONE', role: 'producer',
      nodeId: 'file:src/main/java/DispatchPublisher.java', domain: '派单', confidence: 0.9,
    });
    expect(out.consumes).toHaveLength(1);
    expect(out.consumes[0]).toMatchObject({
      kind: 'mq', key: 'topic:DISPATCH_DONE', role: 'consumer',
      nodeId: 'file:src/main/java/DispatchListener.java', confidence: 0.9,
    });
  });

  it('resolves a topic from an in-file final String constant (lower confidence)', () => {
    const out = mq.extract(
      [{
        path: 'P.java',
        content: `package p;
public class P {
  private static final String TOPIC = "ORDER_CREATED";
  void f(Object x){ mqSendService.send(TOPIC, x); }
}`,
      }],
      {},
    );
    expect(out.provides[0]).toMatchObject({ key: 'topic:ORDER_CREATED', confidence: 0.8 });
  });

  it('surfaces an unresolvable consumer topic as topic:? (R5)', () => {
    const out = mq.extract(
      [{
        path: 'CfgListener.java',
        content: `package p;
public class CfgListener extends AbstractRocketMqHandler {
  // topic injected from Apollo config at runtime
}`,
      }],
      {},
    );
    expect(out.consumes).toHaveLength(1);
    expect(out.consumes[0]).toMatchObject({ key: 'topic:?', unresolvedTopic: true, confidence: 0.3 });
  });

  it('honors configurable consumerBaseClass / producerClass', () => {
    const out = mq.extract(
      [
        {
          path: 'H.java',
          content: `package p;
public class H extends BaseMq { public String getTopic(){ return "T"; } }`,
        },
        {
          path: 'S.java',
          content: `package p; class S { void f(){ myBus.send("T", x); } }`,
        },
      ],
      { mq: { consumerBaseClass: 'BaseMq', producerClass: 'myBus' } },
    );
    expect(out.consumes[0]).toMatchObject({ key: 'topic:T', role: 'consumer' });
    expect(out.provides[0]).toMatchObject({ key: 'topic:T', role: 'producer' });
  });

  it('ignores unrelated .send() calls and non-java files', () => {
    const out = mq.extract(
      [
        { path: 'A.java', content: `class A { void f(){ list.send("x"); emailClient.send("y"); } }` },
        { path: 'b.ts', content: `mqSendService.send("FROM_FE")` },
      ],
      {},
    );
    expect(out.provides).toEqual([]);
  });

  // --- real aurora shape: topic is Apollo-config-sourced, supplied via manifest ---
  it('producer @Value("${...topic...}") in MqSendService resolves via mq.topics.byProp', () => {
    const file = {
      path: 'src/main/java/com/hk/simba/pre/mq/producer/MqSendService.java',
      content: `package com.hk.simba.pre.mq.producer;
@Service
public class MqSendService {
  @Value("\${mq.rocket-mq.producerTopic_dispatchAnalysisNoticed}")
  private String producerTopicDispatchAnalysisNoticed;
  @Value("\${mq.rocket-mq.producerTag_dispatchAnalysisNoticed_pre_dispatch}")
  private String producerTag;
}`,
    };
    const out = mq.extract([file], {
      domains: ['派单'],
      mq: { topics: { byProp: { 'mq.rocket-mq.producerTopic_dispatchAnalysisNoticed': 'DISPATCH_ANALYSIS_NOTICED' } } },
    });
    // the tag @Value is excluded; only the topic prop is emitted, resolved via config
    expect(out.provides).toHaveLength(1);
    expect(out.provides[0]).toMatchObject({
      kind: 'mq', key: 'topic:DISPATCH_ANALYSIS_NOTICED', role: 'producer', via: 'config', domain: '派单', confidence: 0.85,
    });
  });

  it('producer topic prop without a manifest mapping surfaces as topicProp:KEY (R5)', () => {
    const file = {
      path: 'MqSendService.java',
      content: `package p;
public class MqSendService {
  @Value("\${mq.rocket-mq.producerTopic_x}")
  private String t;
}`,
    };
    const out = mq.extract([file], {}); // no mq.topics
    expect(out.provides).toEqual([
      expect.objectContaining({ key: 'topicProp:mq.rocket-mq.producerTopic_x', unresolvedTopic: true, confidence: 0.3 }),
    ]);
  });

  it('consumer handler FQN resolves via mq.topics.byHandler', () => {
    const file = {
      path: 'src/main/java/com/hk/simba/aurora/mq/ServiceWorkOrderDesignatedHandler.java',
      content: `package com.hk.simba.aurora.mq;
import org.apache.rocketmq.common.message.MessageExt;
@Service
public class ServiceWorkOrderDesignatedHandler extends AbstractRocketMqHandler {
  @Override public boolean handleMessage(MessageExt m) { return true; }
}`,
    };
    const out = mq.extract([file], {
      mq: { topics: { byHandler: { 'com.hk.simba.aurora.mq.ServiceWorkOrderDesignatedHandler': 'WORKORDER_DESIGNATED' } } },
    });
    expect(out.consumes).toHaveLength(1);
    expect(out.consumes[0]).toMatchObject({
      kind: 'mq', key: 'topic:WORKORDER_DESIGNATED', role: 'consumer', via: 'config', confidence: 0.85,
    });
  });

  it('consumer with no getTopic() and no mapping surfaces topic:? with handlerFqn (real aurora)', () => {
    const file = {
      path: 'NoticeUserTaskCompleteHandler.java',
      content: `package com.hk.simba.aurora.mq;
import org.apache.rocketmq.common.message.MessageExt;
public class NoticeUserTaskCompleteHandler extends AbstractRocketMqHandler {
  @Override public boolean handleMessage(MessageExt m) { return true; }
}`,
    };
    const out = mq.extract([file], {});
    expect(out.consumes[0]).toMatchObject({
      key: 'topic:?', unresolvedTopic: true, confidence: 0.3,
      handlerFqn: 'com.hk.simba.aurora.mq.NoticeUserTaskCompleteHandler',
    });
  });
});

describe('diff-cross-edges', () => {
  it('reports added / removed / unchanged by edge identity (id ignored)', () => {
    const oldR = { crossEdges: [{ id: 'x1', protocol: 'dubbo', sourceService: 'a', targetService: 'b', key: 'K1' }] };
    const newR = {
      crossEdges: [
        { id: 'x9', protocol: 'dubbo', sourceService: 'a', targetService: 'b', key: 'K1' },
        { id: 'x10', protocol: 'mq', sourceService: 'a', targetService: 'c', key: 'topic:T' },
      ],
    };
    const d = diffCrossEdges(oldR, newR);
    expect(d.stats).toEqual({ added: 1, removed: 0, unchanged: 1 });
    expect(d.added[0].key).toBe('topic:T');
    expect(d.removed).toEqual([]);
  });

  it('detects a removed edge', () => {
    const oldR = { crossEdges: [{ protocol: 'dubbo', sourceService: 'a', targetService: 'b', key: 'K1' }] };
    const newR = { crossEdges: [] };
    const d = diffCrossEdges(oldR, newR);
    expect(d.stats).toEqual({ added: 0, removed: 1, unchanged: 0 });
    expect(d.removed[0].key).toBe('K1');
  });
});
