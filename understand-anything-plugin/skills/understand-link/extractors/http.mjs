#!/usr/bin/env node
/**
 * extractors/http.mjs
 *
 * HTTP boundary extractor.
 *
 *   provides (v0.1): Spring-MVC routes. A method-level @GetMapping/@PostMapping/
 *     … (or @RequestMapping with method=…) combines with the class-level
 *     @RequestMapping base path, then is normalized with the service's gateway
 *     prefix / base path (from the manifest) so consumers' absolute URLs match.
 *     key = `VERB /normalized/path`.
 *
 *   consumes (v0.1): NOT extracted. fe→backend (axios / service modules) and
 *     RestTemplate URL consumers are low-confidence and deferred to v0.2
 *     (see DESIGN.md §6.1 / §14). Returned as an empty array.
 *
 * Pure module: `extract(files, ctx)` takes pre-read files + manifest http config.
 */

import { scanJava, hasAnnotation, getAnnotation, firstStringArg } from './java-scan.mjs';

export const kind = 'http';

const MAPPING_VERBS = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

function soleDomain(domains) {
  return Array.isArray(domains) && domains.length === 1 ? domains[0] : undefined;
}

/** Join path segments into a single normalized absolute path. */
export function normalizePath(segments) {
  const joined = segments
    .filter((s) => s && String(s).trim())
    .map((s) => String(s).trim())
    .join('/');
  const collapsed = ('/' + joined).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed === '' ? '/' : collapsed;
}

function parseRequestMethodVerb(raw) {
  const m = raw.match(/RequestMethod\.(\w+)/);
  return m ? m[1].toUpperCase() : null;
}

/** Map a method's annotation buffer to a route, or null if none is a mapping. */
function methodToRoute(annotations) {
  for (const a of annotations) {
    if (MAPPING_VERBS[a.name]) {
      return { verb: MAPPING_VERBS[a.name], path: firstStringArg(a.raw) || '', annotation: a.name };
    }
    if (a.name === 'RequestMapping') {
      return {
        verb: parseRequestMethodVerb(a.raw) || 'ANY',
        path: firstStringArg(a.raw) || '',
        annotation: a.name,
      };
    }
  }
  return null;
}

/**
 * @param {Array<{path:string, content:string}>} files
 * @param {{serviceId:string, domains?:string[], http?:{basePath?:string, gatewayPrefix?:string}}} ctx
 * @returns {{provides:Array, consumes:Array}}
 */
export function extract(files, ctx = {}) {
  const provides = [];
  const consumes = []; // deferred to v0.2
  const domain = soleDomain(ctx.domains);
  const gatewayPrefix = ctx.http?.gatewayPrefix || '';
  const basePath = ctx.http?.basePath || '';

  for (const { path, content } of files) {
    const scan = scanJava(content);
    const nodeId = `file:${path}`;

    // Class-level @RequestMapping base path (first one found in the file).
    let classBase = '';
    for (const cls of scan.classes) {
      const rm = getAnnotation(cls.annotations, 'RequestMapping');
      if (rm) {
        classBase = firstStringArg(rm.raw) || '';
        break;
      }
    }

    for (const meth of scan.methods) {
      const route = methodToRoute(meth.annotations);
      if (!route) continue;
      const full = normalizePath([gatewayPrefix, basePath, classBase, route.path]);
      const p = {
        kind: 'http',
        key: `${route.verb} ${full}`,
        nodeId,
        confidence: 0.9,
        evidence: `@${route.annotation} ${route.path || '/'}`,
      };
      if (domain) p.domain = domain;
      provides.push(p);
    }
  }

  return { provides, consumes };
}
