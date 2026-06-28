#!/usr/bin/env node
/**
 * build-registry.mjs  —  Phase 2
 *
 * Upsert every boundary descriptor in <boundaries-dir> into the registry
 * (DESIGN.md §5.2). Goes through the registry backend interface (json default,
 * sqlite optional) so the backend stays swappable. Incremental: the existing
 * registry is loaded and each boundary is upserted (replacing that service's prior
 * rows), so a run that only re-extracted some services still produces a complete
 * registry.
 *
 * Usage:
 *   node build-registry.mjs <boundaries-dir> <registry-path> [--backend=json|sqlite]
 */

import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore, emptyRegistry, upsertService } from './registry/index.mjs';

/** Pure: fold an array of boundary descriptors into a registry document. */
export function buildRegistry(boundaries, base) {
  const reg = base || emptyRegistry();
  for (const b of boundaries) upsertService(reg, b);
  // Deterministic ordering so the file is stable across runs / git-diffable.
  reg.services.sort((a, b2) => a.serviceId.localeCompare(b2.serviceId));
  const rowSort = (a, b2) =>
    a.serviceId.localeCompare(b2.serviceId) || a.kind.localeCompare(b2.kind) || a.key.localeCompare(b2.key);
  reg.provides.sort(rowSort);
  reg.consumes.sort(rowSort);
  reg.serviceDomains.sort(
    (a, b2) => a.serviceId.localeCompare(b2.serviceId) || a.domain.localeCompare(b2.domain),
  );
  return reg;
}

async function main() {
  const args = process.argv.slice(2);
  const backendArg = args.find((a) => a.startsWith('--backend='));
  const backend = backendArg ? backendArg.split('=')[1] : 'json';
  const [boundariesDir, registryPath] = args.filter((a) => !a.startsWith('--'));
  if (!boundariesDir || !registryPath) {
    process.stderr.write('Usage: node build-registry.mjs <boundaries-dir> <registry-path> [--backend=json|sqlite]\n');
    process.exit(1);
  }

  const files = existsSync(boundariesDir)
    ? readdirSync(boundariesDir).filter((f) => f.endsWith('.json')).sort()
    : [];
  const boundaries = files.map((f) => JSON.parse(readFileSync(join(boundariesDir, f), 'utf-8')));

  const store = await getStore(backend);
  const base = store.load(registryPath) || emptyRegistry();

  const reg = buildRegistry(boundaries, base);
  store.save(registryPath, reg);
  process.stderr.write(
    `Info: understand-link: registry (${backend}) has ${reg.services.length} services, ` +
      `${reg.provides.length} provides, ${reg.consumes.length} consumes.\n`,
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
    process.stderr.write(`build-registry.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
