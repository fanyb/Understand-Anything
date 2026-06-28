#!/usr/bin/env node
/**
 * registry/sqlite-store.mjs  —  v0.3 optional registry backend
 *
 * Same backend surface as json-store (`load(path)` / `save(path, reg)`), backed by
 * a real SQLite file via Node's built-in `node:sqlite` (no extra dependency; needs
 * Node ≥22.5). Selected by manifest `registry.backend: "sqlite"` (DESIGN.md §5.2 /
 * §9 / decision ⑤) — for scale beyond JSON or to let an MCP/AI run SQL over the
 * boundary index.
 *
 * The logical tables mirror DESIGN.md §5.2. Each row keeps its scalar join columns
 * (serviceId, kind, key) PLUS the full row JSON in a `data` column, so:
 *   - SQL consumers can filter by `(kind, key)` / serviceId, and
 *   - `load()` round-trips the EXACT same row objects the json backend produces,
 *     so the downstream join (resolve-cross-edges) is byte-for-byte backend-agnostic.
 *
 * `save()` is a full transactional replace (load → fold → save mirrors json's
 * whole-file rewrite; ~10k rows is trivial). Incremental savings live in Phase A
 * extraction, not the registry write.
 */

import { DatabaseSync } from 'node:sqlite';
import { emptyRegistry } from './json-store.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS service (
  serviceId TEXT PRIMARY KEY, repo TEXT, graphRef TEXT, domainRef TEXT,
  sourceHash TEXT, generatedAt TEXT, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provide (
  serviceId TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provide_kindkey ON provide(kind, key);
CREATE TABLE IF NOT EXISTS consume (
  serviceId TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consume_kindkey ON consume(kind, key);
CREATE TABLE IF NOT EXISTS service_domain (
  serviceId TEXT NOT NULL, domain TEXT NOT NULL
);
`;

/** SQLite bindings reject `undefined`; coalesce to null. */
function n(v) {
  return v == null ? null : v;
}

/** Open (creating if needed) and ensure the schema exists. */
function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/**
 * Load the full registry document from a SQLite file (empty doc if the file/tables
 * are new). Rows come back ordered to match the json backend's stable sort.
 */
export function load(path) {
  const db = openDb(path);
  try {
    const reg = emptyRegistry();
    reg.backend = 'sqlite';
    for (const r of db.prepare('SELECT data FROM service ORDER BY serviceId').all()) {
      reg.services.push(JSON.parse(r.data));
    }
    for (const r of db.prepare('SELECT data FROM provide ORDER BY serviceId, kind, key').all()) {
      reg.provides.push(JSON.parse(r.data));
    }
    for (const r of db.prepare('SELECT data FROM consume ORDER BY serviceId, kind, key').all()) {
      reg.consumes.push(JSON.parse(r.data));
    }
    for (const r of db.prepare('SELECT serviceId, domain FROM service_domain ORDER BY serviceId, domain').all()) {
      reg.serviceDomains.push({ serviceId: r.serviceId, domain: r.domain });
    }
    return reg;
  } finally {
    db.close();
  }
}

/** Persist a registry document as a transactional full replace. */
export function save(path, reg) {
  const db = openDb(path);
  try {
    db.exec('BEGIN');
    db.exec('DELETE FROM service; DELETE FROM provide; DELETE FROM consume; DELETE FROM service_domain;');

    const insS = db.prepare(
      'INSERT INTO service (serviceId, repo, graphRef, domainRef, sourceHash, generatedAt, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const s of reg.services) {
      insS.run(s.serviceId, n(s.repo), n(s.graphRef), n(s.domainRef), n(s.sourceHash), n(s.generatedAt), JSON.stringify(s));
    }
    const insP = db.prepare('INSERT INTO provide (serviceId, kind, key, data) VALUES (?, ?, ?, ?)');
    for (const p of reg.provides) insP.run(p.serviceId, p.kind, p.key, JSON.stringify(p));

    const insC = db.prepare('INSERT INTO consume (serviceId, kind, key, data) VALUES (?, ?, ?, ?)');
    for (const c of reg.consumes) insC.run(c.serviceId, c.kind, c.key, JSON.stringify(c));

    const insD = db.prepare('INSERT INTO service_domain (serviceId, domain) VALUES (?, ?)');
    for (const d of reg.serviceDomains) insD.run(d.serviceId, d.domain);

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    db.close();
  }
}
