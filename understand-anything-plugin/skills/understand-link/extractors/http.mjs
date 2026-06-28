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
 *   consumes (v0.2): fe→backend HTTP calls. Two shapes (DESIGN.md §6.1, verified
 *     against fe-backend-aurora):
 *     - `axios.get/post/put/delete/patch('/url', …)` — verb + path are explicit;
 *       detected in any fe file (.ts/.tsx/.js/.jsx/.vue).
 *     - service-module config objects `{ name, url: `${host}/path`, method: 'post' }`
 *       — the real aurora shape: arrays of request descriptors under `src/service/
 *       modules/*`, where the URL is a template literal prefixed by a host var
 *       (`${aurora}`, `${sale}`, …) that names the target service. Only in files
 *       whose path looks like an API/service module; method defaults GET.
 *     The `${host}` prefix is resolved to the target's base path via the manifest's
 *     per-fe-service `http.hostMap` ({ aurora: "/aurora" }) so the key matches the
 *     provider's `VERB /aurora/...`. Unmapped hosts keep the bare path + a
 *     `targetHint`, staying low-confidence (0.5) and missing into `unresolved` (R5).
 *
 * Pure module: `extract(files, ctx)` takes pre-read files + manifest http config.
 */

import { scanJava, getAnnotation, firstStringArg } from './java-scan.mjs';

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
 * Resolve a fe URL (possibly a `${host}/path` template literal) to a route path.
 * A leading `${host}` names the target service; it is replaced by the manifest's
 * `hostMap[host]` base path so the key matches the provider's `VERB /base/...`.
 * @returns {{path:string, targetHint?:string}}
 */
function resolveUrl(raw, hostMap) {
  const u = urlPath(raw);
  const m = u.match(/^\$\{(\w+)\}(\/.*)?$/);
  if (m) {
    const host = m[1];
    const rest = m[2] || '/';
    const base = hostMap[host];
    return base
      ? { path: normalizePath([base, rest]), targetHint: host }
      : { path: normalizePath([rest]), targetHint: host };
  }
  return { path: normalizePath([u]) };
}

/**
 * The smallest `{ … }` object literal containing `fromIndex`, found by brace
 * matching from the nearest preceding `{`. Brace matching (not first `}`) is
 * required because a `${host}` template URL carries a balanced `}` of its own.
 */
function objectScope(content, fromIndex) {
  const open = content.lastIndexOf('{', fromIndex);
  if (open < 0) return content;
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}' && --depth === 0) return content.slice(open, i + 1);
  }
  return content.slice(open);
}

/**
 * fe→backend HTTP consumes for one frontend file. Each call → an `http` consume
 * keyed `VERB /normalized/path` (low confidence; see module header). `hostMap`
 * resolves `${host}` URL prefixes to target base paths (DESIGN.md §6.1).
 */
export function extractFeConsumes(path, content, hostMap = {}) {
  const nodeId = `file:${path}`;
  const byKey = new Map(); // dedupe identical calls within a file

  const add = (verb, raw, evidence) => {
    const { path: routePath, targetHint } = resolveUrl(raw, hostMap);
    const key = `${verb} ${routePath}`;
    if (byKey.has(key)) return;
    const row = { kind: 'http', key, nodeId, confidence: 0.5, evidence };
    if (targetHint) row.targetHint = targetHint;
    byKey.set(key, row);
  };

  // axios.<verb>('/url', …) — explicit verb + path, any fe file.
  const axiosRe = /\baxios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi;
  let m;
  while ((m = axiosRe.exec(content))) {
    add(m[1].toUpperCase(), m[2], `axios.${m[1].toLowerCase()}('${m[2]}')`);
  }

  // { url: `${host}/url`, method: 'post' } — service-module config objects only.
  // `method` is read from the SAME object literal so an adjacent object's method
  // can't leak in; absent → GET. The object boundary is found by brace matching
  // (not first `}`) because a `${host}` URL contains a `}` of its own.
  if (isServiceModule(path)) {
    const urlRe = /\burl\s*:\s*[`'"]([^`'"]+)[`'"]/g;
    while ((m = urlRe.exec(content))) {
      const scope = objectScope(content, m.index);
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
 * @param {{serviceId:string, domains?:string[], http?:{basePath?:string, gatewayPrefix?:string, hostMap?:Record<string,string>}}} ctx
 * @returns {{provides:Array, consumes:Array}}
 */
export function extract(files, ctx = {}) {
  const provides = [];
  const consumes = [];
  const domain = soleDomain(ctx.domains);
  const gatewayPrefix = ctx.http?.gatewayPrefix || '';
  const basePath = ctx.http?.basePath || '';
  const hostMap = ctx.http?.hostMap || {};

  for (const { path, content } of files) {
    // fe→backend consumers (axios / service modules) live in frontend files.
    if (isFeFile(path)) {
      consumes.push(...extractFeConsumes(path, content, hostMap));
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
