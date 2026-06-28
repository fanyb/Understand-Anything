#!/usr/bin/env node
/**
 * check-readiness.mjs  —  Phase 0
 *
 * Reads the hand-maintained manifest and verifies every service has BOTH a
 * knowledge-graph.json (from /understand) and a domain-graph.json (from
 * /understand-domain). These are hard prerequisites (DESIGN.md §7 / decision ②④):
 * a missing graph means the service is SKIPPED and reported — never inferred.
 *
 * Usage:
 *   node check-readiness.mjs <manifest.json> <output-readiness.json>
 *
 * Output JSON:
 *   { manifestPath, baseDir, ready: [serviceId], skipped: [{serviceId, reason, hint}],
 *     services: { <id>: { serviceId, root, graphRef, domainRef, http, protocols, ready } } }
 *
 * Exit code is 0 even when services are skipped — skipping is a normal, expected
 * state ("backfill one, include one next run"). Only malformed input exits 1.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

/** Resolve a manifest-relative path against the manifest's directory. */
function resolvePath(baseDir, p) {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

/** Parse + validate JSON; return null (not throw) on any problem. */
function tryReadJson(path) {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  try {
    JSON.parse(readFileSync(path, 'utf-8'));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `unparseable (${err.message})` };
  }
}

/**
 * Pure: expand each manifest service into absolute paths + config.
 * @returns {Array<{serviceId, repo, root, graphRef, domainRef, http, mq, protocols}>}
 */
export function resolveServicePaths(manifest, baseDir) {
  if (!manifest || !Array.isArray(manifest.services)) {
    throw new Error('manifest must contain a "services" array');
  }
  return manifest.services.map((svc) => {
    if (!svc.serviceId) throw new Error('every service needs a "serviceId"');
    if (!svc.graphRef) throw new Error(`service ${svc.serviceId}: "graphRef" is required`);
    if (!svc.domainRef) throw new Error(`service ${svc.serviceId}: "domainRef" is required`);
    return {
      serviceId: svc.serviceId,
      repo: svc.repo || svc.serviceId,
      root: resolvePath(baseDir, svc.root || svc.repo || '.'),
      graphRef: resolvePath(baseDir, svc.graphRef),
      domainRef: resolvePath(baseDir, svc.domainRef),
      http: svc.http || {},
      mq: svc.mq || {},
      protocols: svc.protocols || { dubbo: true, http: true, mq: true },
    };
  });
}

function main() {
  const [, , manifestPath, outputPath] = process.argv;
  if (!manifestPath || !outputPath) {
    process.stderr.write('Usage: node check-readiness.mjs <manifest.json> <output.json>\n');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const baseDir = dirname(resolve(manifestPath));
  const services = resolveServicePaths(manifest, baseDir);

  const ready = [];
  const skipped = [];
  const serviceMap = {};

  for (const svc of services) {
    const kg = tryReadJson(svc.graphRef);
    const dg = tryReadJson(svc.domainRef);
    const isReady = kg.ok && dg.ok;
    serviceMap[svc.serviceId] = { ...svc, ready: isReady };

    if (isReady) {
      ready.push(svc.serviceId);
    } else {
      const problems = [];
      if (!kg.ok) problems.push(`knowledge-graph.json ${kg.reason}`);
      if (!dg.ok) problems.push(`domain-graph.json ${dg.reason}`);
      const needs = [];
      if (!kg.ok) needs.push('/understand');
      if (!dg.ok) needs.push('/understand-domain');
      const hint = `run ${needs.join(' and ')} in ${svc.root}`;
      skipped.push({ serviceId: svc.serviceId, reason: problems.join('; '), hint });
      process.stderr.write(
        `Warning: understand-link: skipping "${svc.serviceId}" — ${problems.join('; ')}. ${hint}\n`,
      );
    }
  }

  const output = { manifestPath: resolve(manifestPath), baseDir, ready, skipped, services: serviceMap };
  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  process.stderr.write(
    `Info: understand-link: ${ready.length} service(s) ready, ${skipped.length} skipped.\n`,
  );
}

function isCliEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`check-readiness.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
