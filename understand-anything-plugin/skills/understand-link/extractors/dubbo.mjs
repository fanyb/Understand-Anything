#!/usr/bin/env node
/**
 * extractors/dubbo.mjs
 *
 * Dubbo boundary extractor — the most reliable cross-service signal (★★★, no LLM).
 *
 *   provides: a `@DubboService` class exposes each interface it `implements`.
 *             key = interface FQN (resolved via the file's imports).
 *   consumes: a `@DubboReference` field consumes the service whose interface is
 *             the field's type. key = field-type FQN.
 *
 * Both sides join on the interface FQN, so a provide and a consume of the same
 * Dubbo interface link two services together.
 *
 * Pure module: `extract(files, ctx)` takes pre-read files and returns boundary
 * fragments. Disk walking lives in extract-boundaries.mjs.
 */

import { scanJava, resolveFqn, hasAnnotation } from './java-scan.mjs';

export const kind = 'dubbo';

/** A single domain tag is only unambiguous when the service owns exactly one. */
function soleDomain(domains) {
  return Array.isArray(domains) && domains.length === 1 ? domains[0] : undefined;
}

/**
 * @param {Array<{path:string, content:string}>} files  service source files (path relative to service root)
 * @param {{serviceId:string, domains?:string[]}} ctx
 * @returns {{provides:Array, consumes:Array}}
 */
export function extract(files, ctx = {}) {
  const provides = [];
  const consumes = [];
  const domain = soleDomain(ctx.domains);

  for (const { path, content } of files) {
    if (!path.endsWith('.java')) continue;
    const scan = scanJava(content);
    const nodeId = `file:${path}`;

    for (const cls of scan.classes) {
      if (!hasAnnotation(cls.annotations, 'DubboService')) continue;
      for (const iface of cls.implementsList) {
        const { fqn, confidence } = resolveFqn(iface, scan);
        const p = {
          kind: 'dubbo',
          key: fqn,
          nodeId,
          confidence,
          evidence: `@DubboService implements ${iface}`,
        };
        if (domain) p.domain = domain;
        provides.push(p);
      }
    }

    for (const field of scan.fields) {
      if (!hasAnnotation(field.annotations, 'DubboReference')) continue;
      const { fqn, confidence } = resolveFqn(field.type, scan);
      consumes.push({
        kind: 'dubbo',
        key: fqn,
        nodeId,
        confidence,
        evidence: `@DubboReference ${field.type}`,
      });
    }
  }

  return { provides, consumes };
}
