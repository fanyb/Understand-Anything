#!/usr/bin/env node
/**
 * build-registry.mjs  —  Phase 2
 *
 * Upsert every boundary descriptor in <boundaries-dir> into the registry
 * (DESIGN.md §5.2). Goes through the json-store interface so the backend stays
 * swappable. Incremental: if <registry.json> already exists it is loaded and
 * each boundary is upserted (replacing that service's prior rows), so a run that
 * only re-extracted some services still produces a complete registry.
 *
 * Usage:
 *   node build-registry.mjs <boundaries-dir> <registry.json>
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyRegistry, upsertService } from './registry/json-store.mjs';

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

function main() {
  const [, , boundariesDir, registryPath] = process.argv;
  if (!boundariesDir || !registryPath) {
    process.stderr.write('Usage: node build-registry.mjs <boundaries-dir> <registry.json>\n');
    process.exit(1);
  }

  const files = existsSync(boundariesDir)
    ? readdirSync(boundariesDir).filter((f) => f.endsWith('.json')).sort()
    : [];
  const boundaries = files.map((f) => JSON.parse(readFileSync(join(boundariesDir, f), 'utf-8')));

  const base = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, 'utf-8'))
    : emptyRegistry();

  const reg = buildRegistry(boundaries, base);
  writeFileSync(registryPath, JSON.stringify(reg, null, 2), 'utf-8');
  process.stderr.write(
    `Info: understand-link: registry has ${reg.services.length} services, ` +
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
    main();
  } catch (err) {
    process.stderr.write(`build-registry.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
