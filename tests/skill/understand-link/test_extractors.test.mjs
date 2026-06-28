import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(__dirname, '../../../understand-anything-plugin/skills/understand-link/extractors');

const { scanJava, resolveFqn } = await import(resolve(EXT, 'java-scan.mjs'));
const dubbo = await import(resolve(EXT, 'dubbo.mjs'));
const http = await import(resolve(EXT, 'http.mjs'));

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
