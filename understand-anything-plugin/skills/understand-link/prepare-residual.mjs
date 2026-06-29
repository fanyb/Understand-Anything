#!/usr/bin/env node
/**
 * prepare-residual.mjs  —  Phase 4c step 1 (deterministic, opt-in LLM residual)
 *
 * The (kind,key) join (resolve-cross-edges) only matches EXACT keys. Whatever it
 * can't match lands in `unresolved` (R5). Some of those are genuinely external
 * (no provider in the fleet); a few are real cross-service calls the deterministic
 * key missed — a raw URL under a different prefix, a path variable, an MQ topic
 * that wasn't in the manifest map. Those are the "模糊残差" DESIGN.md §6/§14 reserve
 * for a SMALL, targeted LLM pass.
 *
 * To honor R6 (low LLM cost) at 200+ services, this step does the expensive
 * narrowing DETERMINISTICALLY: for each unresolved consume it shortlists the few
 * provider keys of the same protocol that are plausibly the same endpoint/topic
 * (path-suffix / token similarity). The LLM (residual-matcher agent) then only has
 * to pick the right one from a handful — never scan the whole registry.
 *
 * Unresolved entries with no plausible candidate are dropped from the shortlist
 * (they stay unresolved — likely external). The count is reported, never hidden.
 *
 * Usage:
 *   node prepare-residual.mjs <registry-path> <cross-edges.json> <residual-candidates.json> [--backend=json|sqlite] [--max-candidates=5] [--max-entries=200]
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStore } from './registry/index.mjs';

/** Lowercase alphanumeric tokens (splits camelCase boundaries too). */
export function tokens(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** HTTP similarity: same verb required; reward shared trailing path segments. */
function httpScore(consumeKey, provideKey) {
  const [cv, cp = ''] = consumeKey.split(' ');
  const [pv, pp = ''] = provideKey.split(' ');
  if (cv !== pv) return 0;
  const cs = cp.split('/').filter(Boolean);
  const ps = pp.split('/').filter(Boolean);
  let suffix = 0;
  for (let i = 1; i <= Math.min(cs.length, ps.length); i++) {
    if (cs[cs.length - i] === ps[ps.length - i]) suffix++;
    else break;
  }
  if (suffix === 0) return 0; // a shared last segment is the minimum signal
  return suffix * 2 + jaccard(cs, ps);
}

/** MQ similarity: token overlap between the consumer's semantics and a topic. */
function mqScore(consumerTokens, provideKey) {
  return jaccard(consumerTokens, tokens(provideKey.replace(/^topic:/, '')));
}

/** Generic fallback (e.g. dubbo): token overlap on the raw key. */
function genericScore(consumeKey, provideKey) {
  return jaccard(tokens(consumeKey), tokens(provideKey));
}

/**
 * Rank candidate provides for one unresolved consume.
 * @returns {Array<{serviceId, key, nodeId, score}>} top `max`, score-desc.
 */
export function rankCandidates(u, consumeRow, provides, max = 5) {
  const pool = provides.filter((p) => p.kind === u.kind && p.serviceId !== u.consumerService);
  const consumerTokens =
    u.kind === 'mq'
      ? tokens(u.key === 'topic:?' ? consumeRow.handlerFqn || consumeRow.evidence || '' : u.key.replace(/^topic:/, ''))
      : null;

  const scored = [];
  for (const p of pool) {
    let score = 0;
    if (u.kind === 'http') score = httpScore(u.key, p.key);
    else if (u.kind === 'mq') score = mqScore(consumerTokens, p.key);
    else score = genericScore(u.key, p.key);
    if (score > 0) scored.push({ serviceId: p.serviceId, key: p.key, nodeId: p.nodeId, score: Number(score.toFixed(4)) });
  }
  scored.sort((a, b) => b.score - a.score || a.serviceId.localeCompare(b.serviceId) || a.key.localeCompare(b.key));
  return scored.slice(0, max);
}

/**
 * Pure: build the residual candidate shortlist from a registry doc + the join's
 * cross-edges result.
 */
export function prepareResidual(reg, crossResult, { maxCandidates = 5, maxEntries = 200 } = {}) {
  const consumes = reg.consumes || [];
  const findConsume = (u) =>
    consumes.find(
      (c) => c.serviceId === u.consumerService && c.kind === u.kind && c.key === u.key && c.nodeId === u.nodeId,
    ) || {};

  const all = [];
  for (const u of crossResult.unresolved || []) {
    const row = findConsume(u);
    const candidates = rankCandidates(u, row, reg.provides || [], maxCandidates);
    if (!candidates.length) continue;
    all.push({
      unresolved: {
        kind: u.kind,
        key: u.key,
        consumerService: u.consumerService,
        nodeId: u.nodeId,
        ...(row.evidence ? { evidence: row.evidence } : {}),
        ...(row.targetHint ? { targetHint: row.targetHint } : {}),
        ...(row.handlerFqn ? { handlerFqn: row.handlerFqn } : {}),
      },
      candidates,
    });
  }

  // Deterministic order; cap with an explicit (logged) note — never silent.
  all.sort(
    (a, b) =>
      a.unresolved.kind.localeCompare(b.unresolved.kind) ||
      a.unresolved.consumerService.localeCompare(b.unresolved.consumerService) ||
      a.unresolved.key.localeCompare(b.unresolved.key),
  );
  const entries = all.slice(0, maxEntries);

  return {
    entries,
    stats: {
      unresolvedTotal: (crossResult.unresolved || []).length,
      withCandidates: all.length,
      emitted: entries.length,
      droppedNoCandidate: (crossResult.unresolved || []).length - all.length,
      cappedOut: Math.max(0, all.length - entries.length),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : def;
  };
  const backend = opt('backend', 'json');
  const maxCandidates = Number(opt('max-candidates', '5'));
  const maxEntries = Number(opt('max-entries', '200'));
  const [registryPath, crossEdgesPath, outputPath] = args.filter((a) => !a.startsWith('--'));
  if (!registryPath || !crossEdgesPath || !outputPath) {
    process.stderr.write(
      'Usage: node prepare-residual.mjs <registry-path> <cross-edges.json> <residual-candidates.json> [--backend=] [--max-candidates=5] [--max-entries=200]\n',
    );
    process.exit(1);
  }
  const store = await getStore(backend);
  const reg = store.load(registryPath);
  const crossResult = JSON.parse(readFileSync(crossEdgesPath, 'utf-8'));
  const out = prepareResidual(reg, crossResult, { maxCandidates, maxEntries });
  writeFileSync(outputPath, JSON.stringify(out, null, 2), 'utf-8');
  process.stderr.write(
    `Info: understand-link: residual shortlist — ${out.stats.emitted} entr(y/ies) with candidates ` +
      `(of ${out.stats.unresolvedTotal} unresolved; ${out.stats.droppedNoCandidate} have no candidate` +
      (out.stats.cappedOut ? `, ${out.stats.cappedOut} capped out` : '') + `).\n`,
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
    process.stderr.write(`prepare-residual.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
