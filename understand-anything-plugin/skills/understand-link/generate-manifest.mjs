#!/usr/bin/env node
/**
 * generate-manifest.mjs  —  Phase 0 helper (manifest bootstrap)
 *
 * When `/understand-link` finds no manifest, this scans a directory tree for
 * services that have already been analyzed (each owns a
 * `.understand-anything/knowledge-graph.json`) and writes a DRAFT manifest the
 * user then reviews/edits before the pipeline runs (DESIGN.md §13 decision ① —
 * the manifest stays hand-maintained; this only bootstraps the parts that ARE
 * inferable). The fields the static scan cannot infer (http.basePath /
 * gatewayPrefix / hostMap, mq.topics) are left as empty scaffolding and flagged.
 *
 * Usage:
 *   node generate-manifest.mjs <scan-root> <out-manifest.json> [--max-depth=4] [--force]
 *
 * Refuses to overwrite an existing file unless --force (the caller only invokes
 * this when no manifest exists).
 */

import { writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set([
  'target', 'build', 'out', 'node_modules', '.git', '.idea', 'dist',
  '.understand-anything', '.understand-link',
]);
const UA_DIR = '.understand-anything';
const KG_FILE = 'knowledge-graph.json';
const DG_FILE = 'domain-graph.json';

/**
 * Pure-ish: walk `scanRoot` (bounded depth) and return every directory that owns
 * a `.understand-anything/knowledge-graph.json`. Each hit carries whether a
 * domain-graph.json sits next to it (hard prerequisite checked later, Phase 1).
 * @returns {Array<{dir, hasDomain}>} absolute service dirs, sorted.
 */
export function discoverServices(scanRoot, { maxDepth = 4 } = {}) {
  const root = resolve(scanRoot);
  const found = [];
  const walk = (dir, depth) => {
    const kg = join(dir, UA_DIR, KG_FILE);
    if (existsSync(kg)) {
      found.push({ dir, hasDomain: existsSync(join(dir, UA_DIR, DG_FILE)) });
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  if (existsSync(root)) walk(root, 0);
  found.sort((a, b) => a.dir.localeCompare(b.dir));
  return found;
}

/** A manifest-relative path with forward slashes (so it reads the same on any OS). */
function relPath(outDir, abs) {
  const r = relative(outDir, abs).split(sep).join('/');
  return r === '' ? '.' : r;
}

/**
 * Pure: turn discovered service dirs into a draft manifest object. serviceId is
 * the dir name, de-duplicated by prefixing the parent dir name on collision so
 * two services named "service" stay distinct.
 * @returns {{manifest, services: Array<{serviceId, root, hasDomain}>}}
 */
export function buildManifest(found, outDir) {
  const ids = new Map(); // base name → count, for collision detection
  for (const f of found) ids.set(basename(f.dir), (ids.get(basename(f.dir)) || 0) + 1);

  const used = new Set();
  const services = found.map((f) => {
    const base = basename(f.dir);
    let serviceId = base;
    if ((ids.get(base) || 0) > 1) serviceId = `${basename(dirname(f.dir))}-${base}`;
    while (used.has(serviceId)) serviceId = `${serviceId}-2`;
    used.add(serviceId);
    return { serviceId, dir: f.dir, hasDomain: f.hasDomain };
  });

  const manifest = {
    version: '1.0.0',
    registry: { backend: 'json' },
    services: services.map((s) => ({
      serviceId: s.serviceId,
      repo: basename(dirname(s.dir)),
      root: relPath(outDir, s.dir),
      graphRef: relPath(outDir, join(s.dir, UA_DIR, KG_FILE)),
      domainRef: relPath(outDir, join(s.dir, UA_DIR, DG_FILE)),
      // The static scan cannot infer these — fill them in before running (see SKILL.md).
      http: { basePath: '', gatewayPrefix: '' },
    })),
  };
  return { manifest, services: services.map((s) => ({ serviceId: s.serviceId, root: relPath(outDir, s.dir), hasDomain: s.hasDomain })) };
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const opt = (name, def) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : def;
  };
  const positional = args.filter((a) => !a.startsWith('--'));
  const [scanRoot, outPath] = positional;
  if (!scanRoot || !outPath) {
    process.stderr.write('Usage: node generate-manifest.mjs <scan-root> <out-manifest.json> [--max-depth=4] [--force]\n');
    process.exit(1);
  }
  if (existsSync(outPath) && !flags.has('--force')) {
    process.stderr.write(`Error: ${outPath} already exists; refusing to overwrite (pass --force).\n`);
    process.exit(1);
  }

  const maxDepth = Number(opt('max-depth', '4'));
  const found = discoverServices(scanRoot, { maxDepth });
  if (found.length === 0) {
    process.stderr.write(
      `Error: understand-link: found no analyzed services under ${resolve(scanRoot)} ` +
        `(no */${UA_DIR}/${KG_FILE} within depth ${maxDepth}). ` +
        `Run /understand in each service first, or pass a different scan root.\n`,
    );
    process.exit(2);
  }

  const outDir = dirname(resolve(outPath));
  const { manifest, services } = buildManifest(found, outDir);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  process.stderr.write(`Info: understand-link: drafted ${services.length} service(s) into ${outPath}\n`);
  for (const s of services) {
    const dg = s.hasDomain ? '' : ` — Warning: no ${DG_FILE} yet (run /understand-domain in ${s.root})`;
    process.stderr.write(`Info:   - ${s.serviceId} (${s.root})${dg}\n`);
  }
  process.stderr.write(
    'Info: understand-link: DRAFT only — review http.basePath / gatewayPrefix' +
      ' (and mq.topics / http.hostMap where relevant) before continuing.\n',
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
    process.stderr.write(`generate-manifest.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
