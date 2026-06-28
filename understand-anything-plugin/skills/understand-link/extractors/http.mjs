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
 *   consumes (v0.2): fe→backend HTTP calls. Two shapes (DESIGN.md §6.1):
 *     - `axios.get/post/put/delete/patch('/url', …)` — verb + path are explicit;
 *       detected in any fe file (.ts/.tsx/.js/.jsx/.vue).
 *     - service-module config objects `{ url: '/url', method: 'post' }` — only in
 *       files whose path looks like an API/service module (DESIGN.md: `src/service/
 *       modules/*`), where a bare `url:` is reliably a request; method defaults GET.
 *     fe URLs are matched against provider keys verbatim (they already include the
 *     gateway prefix the browser hits), so these are low-confidence (0.5) and miss
 *     gracefully into `unresolved` (R5) when the convention differs.
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

const FE_EXT_RE = /\.(ts|tsx|js|jsx|vue)$/;
/** A frontend source file (excluding TypeScript declaration files). */
function isFeFile(path) {
  return FE_EXT_RE.test(path) && !path.endsWith('.d.ts');
}
/** Files where a bare `url:` is reliably a request config (service/api modules). */
function isServiceModule(path) {
  return /(?:^|\/)(?:service|services|api|apis|request|requests|http|modules)(?:\/|\.|$)/i.test(path);
}

/** Path part of a fe URL: drop query/hash, keep the route for key matching. */
function urlPath(raw) {
  return String(raw).split('?')[0].split('#')[0];
}

/**
 * fe→backend HTTP consumes for one frontend file. Each call → an `http` consume
 * keyed `VERB /normalized/path` (low confidence; see module header).
 */
export function extractFeConsumes(path, content) {
  const nodeId = `file:${path}`;
  const byKey = new Map(); // dedupe identical calls within a file

  const add = (verb, raw, evidence) => {
    const key = `${verb} ${normalizePath([urlPath(raw)])}`;
    if (byKey.has(key)) return;
    byKey.set(key, { kind: 'http', key, nodeId, confidence: 0.5, evidence });
  };

  // axios.<verb>('/url', …) — explicit verb + path, any fe file.
  const axiosRe = /\baxios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi;
  let m;
  while ((m = axiosRe.exec(content))) {
    add(m[1].toUpperCase(), m[2], `axios.${m[1].toLowerCase()}('${m[2]}')`);
  }

  // { url: '/url', method: 'post' } — service-module config objects only. `method`
  // is read from the SAME object literal (between the enclosing braces) so an
  // adjacent object's method can't leak in; absent → GET.
  if (isServiceModule(path)) {
    const urlRe = /\burl\s*:\s*[`'"]([^`'"]+)[`'"]/g;
    while ((m = urlRe.exec(content))) {
      const open = content.lastIndexOf('{', m.index);
      const close = content.indexOf('}', m.index);
      const scope = content.slice(open >= 0 ? open : 0, close >= 0 ? close : content.length);
      const mm = scope.match(/\bmethod\s*:\s*[`'"]?(get|post|put|delete|patch)[`'"]?/i);
      const verb = mm ? mm[1].toUpperCase() : 'GET';
      add(verb, m[1], `service module { url: '${m[1]}', method: '${verb.toLowerCase()}' }`);
    }
  }

  return [...byKey.values()];
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
  const consumes = [];
  const domain = soleDomain(ctx.domains);
  const gatewayPrefix = ctx.http?.gatewayPrefix || '';
  const basePath = ctx.http?.basePath || '';

  for (const { path, content } of files) {
    // fe→backend consumers (axios / service modules) live in frontend files.
    if (isFeFile(path)) {
      consumes.push(...extractFeConsumes(path, content));
      continue;
    }
    if (!path.endsWith('.java')) continue;

    // Spring-MVC provider routes from Java controllers.
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
