#!/usr/bin/env node
/**
 * extract-boundaries.mjs  —  Phase 1 (per-service, parallelizable, incremental)
 *
 * For each READY service (from readiness.json), walk its source tree, run the
 * enabled protocol extractors, and write a boundary descriptor
 * `boundaries/<serviceId>.json` (DESIGN.md §5.1).
 *
 * Only depends on the service itself → changing one service re-extracts only it.
 * `--changed` skips services whose source hash matches the existing boundary file.
 *
 * Usage:
 *   node extract-boundaries.mjs <readiness.json> <boundaries-dir> [--changed]
 *
 * Extractors are plugins (extractors/<proto>.mjs), each exporting
 * `extract(files, ctx) → {provides, consumes}`. Adding a protocol = adding a file
 * (DESIGN.md §10). v0.1 ships dubbo + http; mq is v0.2.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Protocol → extractor module. v0.1: dubbo + http (mq deferred to v0.2).
const EXTRACTOR_MODULES = {
  dubbo: './extractors/dubbo.mjs',
  http: './extractors/http.mjs',
};

const SKIP_DIRS = new Set(['target', 'build', 'out', 'node_modules', '.git', '.idea', 'dist']);

/** Recursively collect `.java` files under `root`, skipping build/vendor dirs. */
function collectJavaFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.java')) {
        out.push(full);
      }
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out.sort();
}

/** domain-graph.json → list of domain names (nodes of type "domain"). */
function readDomains(domainRef) {
  try {
    const dg = JSON.parse(readFileSync(domainRef, 'utf-8'));
    return (dg.nodes || []).filter((n) => n.type === 'domain').map((n) => n.name);
  } catch {
    return [];
  }
}

/** knowledge-graph.json → {nodes, edges} counts (for system-graph service stats). */
function readGraphStats(graphRef) {
  try {
    const kg = JSON.parse(readFileSync(graphRef, 'utf-8'));
    return { nodes: (kg.nodes || []).length, edges: (kg.edges || []).length };
  } catch {
    return { nodes: 0, edges: 0 };
  }
}

async function loadExtractors(protocols) {
  const active = [];
  for (const [proto, modPath] of Object.entries(EXTRACTOR_MODULES)) {
    if (protocols[proto] === false) continue;
    const mod = await import(pathToFileURL(resolve(__dirname, modPath)).href);
    active.push({ proto, extract: mod.extract });
  }
  return active;
}

/**
 * Build one boundary descriptor for a service. Pure-ish: reads source files but
 * takes the resolved service config. Exported for tests.
 */
export async function extractServiceBoundary(svc, extractors) {
  const absFiles = collectJavaFiles(svc.root);
  const files = [];
  const hasher = createHash('sha256');
  for (const abs of absFiles) {
    let content;
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const relPath = relative(svc.root, abs).split(sep).join('/');
    files.push({ path: relPath, content });
    hasher.update(relPath).update('\0').update(content).update('\0');
  }

  const domains = readDomains(svc.domainRef);
  const ctx = { serviceId: svc.serviceId, domains, http: svc.http || {} };

  const provides = [];
  const consumes = [];
  for (const { extract } of extractors) {
    const out = extract(files, ctx);
    provides.push(...out.provides);
    consumes.push(...out.consumes);
  }

  return {
    serviceId: svc.serviceId,
    repo: svc.repo,
    graphRef: svc.graphRef,
    domainRef: svc.domainRef,
    sourceHash: 'sha256:' + hasher.digest('hex'),
    domains,
    stats: readGraphStats(svc.graphRef),
    provides,
    consumes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const [readinessPath, boundariesDir] = positional;
  if (!readinessPath || !boundariesDir) {
    process.stderr.write('Usage: node extract-boundaries.mjs <readiness.json> <boundaries-dir> [--changed]\n');
    process.exit(1);
  }
  const onlyChanged = flags.has('--changed');

  const readiness = JSON.parse(readFileSync(readinessPath, 'utf-8'));
  mkdirSync(boundariesDir, { recursive: true });

  let extracted = 0;
  let skippedUnchanged = 0;

  for (const serviceId of readiness.ready) {
    const svc = readiness.services[serviceId];
    const extractors = await loadExtractors(svc.protocols || {});
    const outPath = join(boundariesDir, `${serviceId}.json`);

    const boundary = await extractServiceBoundary(svc, extractors);

    if (onlyChanged && existsSync(outPath)) {
      try {
        const prev = JSON.parse(readFileSync(outPath, 'utf-8'));
        if (prev.sourceHash === boundary.sourceHash) {
          skippedUnchanged++;
          continue;
        }
      } catch {
        // fall through and rewrite
      }
    }

    boundary.generatedAt = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(boundary, null, 2), 'utf-8');
    extracted++;
    process.stderr.write(
      `Info: understand-link: ${serviceId} → ${boundary.provides.length} provides, ${boundary.consumes.length} consumes\n`,
    );
  }

  process.stderr.write(
    `Info: understand-link: extracted ${extracted} service boundary file(s)` +
      (onlyChanged ? `, ${skippedUnchanged} unchanged` : '') + `.\n`,
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
    await main();
  } catch (err) {
    process.stderr.write(`extract-boundaries.mjs failed: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  }
}
