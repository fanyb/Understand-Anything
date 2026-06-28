#!/usr/bin/env node
/**
 * registry/index.mjs  —  backend factory + shared doc utilities
 *
 * Single import point for build-registry / resolve-cross-edges. Picks the
 * persistence backend by name (manifest `registry.backend`, DESIGN.md decision ⑤)
 * and re-exports the backend-agnostic doc utilities both backends share.
 *
 *   getStore(backend) → { load(path), save(path, reg) }
 *
 * The sqlite backend is imported lazily so json users never load `node:sqlite`
 * (and get a clear error if they ask for sqlite on a runtime without it).
 */

import * as jsonStore from './json-store.mjs';

export { emptyRegistry, upsertService, removeService, buildIndexes, indexKey } from './json-store.mjs';

/**
 * Resolve a registry backend to its { load, save } surface.
 * @param {('json'|'sqlite'|undefined)} backend
 */
export async function getStore(backend = 'json') {
  if (!backend || backend === 'json') return jsonStore;
  if (backend === 'sqlite') {
    try {
      return await import('./sqlite-store.mjs');
    } catch (err) {
      throw new Error(
        `understand-link: sqlite registry backend unavailable (needs Node ≥22.5 with node:sqlite): ${err.message}`,
      );
    }
  }
  throw new Error(`understand-link: unknown registry backend "${backend}" (expected "json" or "sqlite")`);
}
