#!/usr/bin/env node
/**
 * merge-residual.mjs  —  Phase 4c step 3 (deterministic fold of LLM matches)
 *
 * Takes the residual-matcher agent's chosen matches and folds the CONFIRMED ones
 * into the cross-edges result as `via: "llm"` edges (confidence capped below the
 * deterministic tier), removing them from `unresolved`. The agent only proposes;
 * this script deterministically validates against the registry (the chosen provide
 * must actually exist) and rebuilds the result so the output is stable + trusted.
 *
 * residual-matches.json shape (agent output):
 *   { matches: [ { kind, key, consumerService, nodeId,
 *                  chosen: { serviceId, key } | null, confidence, reason } ] }
 *
 * Usage:
 *   node merge-residual.mjs <registry-path> <cross-edges.json> <residual-matches.json> <out-cross-edges.json> [--backend=json|sqlite] [--min-confidence=0.4]
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStore, buildIndexes, indexKey } from './registry/index.mjs';

const LLM_CONFIDENCE_CAP = 0.6; // residual edges never outrank deterministic ones

/** Re-sort + re-id cross edges exactly like resolve-cross-edges, and re-stat. */
function finalize(edges, unresolved) {
  edges.sort(
    (a, b) =>
      a.protocol.localeCompare(b.protocol) ||
      a.sourceService.localeCompare(b.sourceService) ||
      a.targetService.localeCompare(b.targetService) ||
      a.key.localeCompare(b.key),
  );
  edges.forEach((e, i) => {
    e.id = `x${i + 1}`;
  });
  unresolved.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.key.localeCompare(b.key) ||
      a.consumerService.localeCompare(b.consumerService),
  );
  const byProtocol = {};
  for (const e of edges) byProtocol[e.protocol] = (byProtocol[e.protocol] || 0) + 1;
  return {
    crossEdges: edges,
    unresolved,
    stats: {
      crossEdges: edges.length,
      unresolved: unresolved.length,
      byProtocol,
      llmResolved: edges.filter((e) => e.via === 'llm').length,
    },
  };
}

/**
 * Pure: merge confirmed residual matches into a cross-edges result.
 * @returns the rebuilt { crossEdges, unresolved, stats }.
 */
export function mergeResidual(reg, crossResult, matchesDoc, { minConfidence = 0.4 } = {}) {
  const { provideIndex, serviceById } = buildIndexes(reg);
  const graphRefOf = (id) => serviceById.get(id)?.graphRef || null;

  const edges = [...(crossResult.crossEdges || [])];
  let unresolved = [...(crossResult.unresolved || [])];
  const have = new Set(edges.map((e) => `${e.sourceService} ${e.targetService} ${e.protocol} ${e.key}`));

  for (const m of matchesDoc.matches || []) {
    if (!m.chosen || (m.confidence ?? 0) < minConfidence) continue;

    // Validate the chosen provide actually exists (agent only proposes).
    const candidates = provideIndex.get(indexKey(m.kind, m.chosen.key)) || [];
    const provide = candidates.find((p) => p.serviceId === m.chosen.serviceId);
    if (!provide) continue;

    const dedupe = `${m.consumerService} ${provide.serviceId} ${m.kind} ${provide.key}`;
    if (have.has(dedupe)) continue;
    have.add(dedupe);

    edges.push({
      type: 'calls',
      protocol: m.kind,
      domain: provide.domain,
      sourceService: m.consumerService,
      targetService: provide.serviceId,
      key: provide.key,
      from: { graphRef: graphRefOf(m.consumerService), nodeId: m.nodeId },
      to: { graphRef: graphRefOf(provide.serviceId), nodeId: provide.nodeId },
      confidence: Math.min(m.confidence ?? 0.5, LLM_CONFIDENCE_CAP),
      via: 'llm',
      evidence: `LLM residual: ${m.reason || 'matched'} (consume ${m.key})`,
    });

    // Drop the now-resolved consume from unresolved.
    unresolved = unresolved.filter(
      (u) => !(u.kind === m.kind && u.key === m.key && u.consumerService === m.consumerService && u.nodeId === m.nodeId),
    );
  }

  return finalize(edges, unresolved);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : def;
  };
  const backend = opt('backend', 'json');
  const minConfidence = Number(opt('min-confidence', '0.4'));
  const [registryPath, crossEdgesPath, matchesPath, outputPath] = args.filter((a) => !a.startsWith('--'));
  if (!registryPath || !crossEdgesPath || !matchesPath || !outputPath) {
    process.stderr.write(
      'Usage: node merge-residual.mjs <registry-path> <cross-edges.json> <residual-matches.json> <out-cross-edges.json> [--backend=] [--min-confidence=0.4]\n',
    );
    process.exit(1);
  }
  const store = await getStore(backend);
  const reg = store.load(registryPath);
  const crossResult = JSON.parse(readFileSync(crossEdgesPath, 'utf-8'));
  const matchesDoc = JSON.parse(readFileSync(matchesPath, 'utf-8'));
  const merged = mergeResidual(reg, crossResult, matchesDoc, { minConfidence });
  writeFileSync(outputPath, JSON.stringify(merged, null, 2), 'utf-8');
  process.stderr.write(
    `Info: understand-link: merged ${merged.stats.llmResolved} LLM residual edge(s); ` +
      `${merged.stats.crossEdges} cross-service edge(s), ${merged.stats.unresolved} unresolved.\n`,
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
    process.stderr.write(`merge-residual.mjs failed: ${err.message}\n`);
    process.exit(1);
  }
}
