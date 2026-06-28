#!/usr/bin/env node
/**
 * extractors/mq.mjs  —  v0.2
 *
 * MQ boundary extractor for this project's *self-wrapped* RocketMQ (DESIGN.md
 * §6.1: no standard `@RocketMQMessageListener` / `rocketMQTemplate`):
 *
 *   provides (producer): a `MqSendService.send("TOPIC", …)` call site. The topic
 *     is the first argument, resolved from a string literal or an in-file
 *     `final String` constant. role = "producer". key = `topic:NAME`.
 *   consumes (consumer): a class that `extends AbstractRocketMqHandler`. The topic
 *     is resolved from a `getTopic()` override or a `super(…)` constructor call.
 *     role = "consumer". key = `topic:NAME`.
 *
 * Producer and consumer of the same topic join on `topic:NAME`, yielding a
 * cross-service edge in the consumer→producer (dependency) direction — the same
 * convention as Dubbo/HTTP (a consumer depends on the producer's messages).
 *
 * Topic-source confirmation (DESIGN.md §13): the exact place a topic is written
 * (getTopic / constant / Apollo config) is environment-specific. This extractor
 * resolves the *statically determinable* cases (literal + in-file constant);
 * runtime/config-sourced topics cannot be resolved and are surfaced, not guessed:
 *   - A consumer whose topic can't be resolved still emits a consume with the
 *     non-matching key `topic:?` so it lands in `unresolved` (R5) for follow-up.
 *   - A producer whose topic can't be resolved is skipped (no join path exists
 *     for an unknown-topic producer); the count is reported by extract-boundaries.
 *
 * The handler base class / send class names are configurable per service
 * (`mq.consumerBaseClass` / `mq.producerClass`) so other services that wrap
 * RocketMQ differently only need manifest config, not a code change.
 *
 * Pure module: `extract(files, ctx)` takes pre-read files and returns boundary
 * fragments. Disk walking lives in extract-boundaries.mjs.
 */

import { scanJava } from './java-scan.mjs';

export const kind = 'mq';

const DEFAULT_CONSUMER_BASE = 'AbstractRocketMqHandler';
const DEFAULT_PRODUCER_CLASS = 'MqSendService';

/** A single domain tag is only unambiguous when the service owns exactly one. */
function soleDomain(domains) {
  return Array.isArray(domains) && domains.length === 1 ? domains[0] : undefined;
}

/** 1-based line number of a character offset in `content`. */
function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/** Collect `[static] final String NAME = "VALUE";` constants for topic resolution. */
function collectStringConstants(content) {
  const map = {};
  const re = /(?:static\s+)?final\s+String\s+([A-Za-z_]\w*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(content))) map[m[1]] = m[2];
  return map;
}

/**
 * Resolve a topic argument expression to a concrete string.
 * @returns {{topic:string, via:'literal'|'const'}|null}
 */
function resolveTopicArg(expr, consts) {
  const e = expr.trim();
  const lit = e.match(/^"([^"]*)"/);
  if (lit) return { topic: lit[1], via: 'literal' };
  const id = e.match(/^([A-Za-z_][\w.]*)$/);
  if (id) {
    const name = id[1].split('.').pop();
    if (consts[name] != null) return { topic: consts[name], via: 'const' };
  }
  return null;
}

/** Resolve an `AbstractRocketMqHandler` subclass's topic from getTopic()/super(). */
function resolveConsumerTopic(content, consts) {
  const getTopic = content.match(/getTopic\s*\([^)]*\)\s*\{[^{}]*?return\s+([^;]+);/);
  if (getTopic) {
    const r = resolveTopicArg(getTopic[1], consts);
    if (r) return r;
  }
  const sup = content.match(/\bsuper\s*\(\s*([^,;)]+)/);
  if (sup) {
    const r = resolveTopicArg(sup[1], consts);
    if (r) return r;
  }
  return null;
}

/**
 * @param {Array<{path:string, content:string}>} files  service source files
 * @param {{serviceId:string, domains?:string[], mq?:{consumerBaseClass?:string, producerClass?:string}}} ctx
 * @returns {{provides:Array, consumes:Array}}
 */
export function extract(files, ctx = {}) {
  const provides = [];
  const consumes = [];
  const domain = soleDomain(ctx.domains);
  const consumerBase = ctx.mq?.consumerBaseClass || DEFAULT_CONSUMER_BASE;
  const producerClass = ctx.mq?.producerClass || DEFAULT_PRODUCER_CLASS;
  const producerHint = producerClass.toLowerCase();

  const sendRe = /\b([A-Za-z_]\w*)\s*\.\s*send\s*\(\s*([^,;)]+)/g;

  for (const { path, content } of files) {
    if (!path.endsWith('.java')) continue;
    const nodeId = `file:${path}`;
    const consts = collectStringConstants(content);
    const scan = scanJava(content);

    // --- producers: <MqSendService>.send("TOPIC", …) ---
    let m;
    sendRe.lastIndex = 0;
    while ((m = sendRe.exec(content))) {
      const recv = m[1];
      const isMqSend =
        recv === producerClass || recv.toLowerCase() === producerHint || recv.toLowerCase().includes('mqsend');
      if (!isMqSend) continue;
      const resolved = resolveTopicArg(m[2], consts);
      if (!resolved) continue; // unknown-topic producer: no join path, skip (reported by caller)
      const p = {
        kind: 'mq',
        key: `topic:${resolved.topic}`,
        role: 'producer',
        nodeId,
        confidence: resolved.via === 'literal' ? 0.9 : 0.8,
        evidence: `${recv}.send(${resolved.via === 'literal' ? `"${resolved.topic}"` : m[2].trim()})`,
        line: lineOf(content, m.index),
      };
      if (domain) p.domain = domain;
      provides.push(p);
    }

    // --- consumers: class extends AbstractRocketMqHandler ---
    for (const cls of scan.classes) {
      if (cls.extendsName !== consumerBase) continue;
      const resolved = resolveConsumerTopic(content, consts);
      if (resolved) {
        consumes.push({
          kind: 'mq',
          key: `topic:${resolved.topic}`,
          role: 'consumer',
          nodeId,
          confidence: resolved.via === 'literal' ? 0.9 : 0.8,
          evidence: `extends ${consumerBase} (topic ${resolved.via})`,
          line: cls.line,
        });
      } else {
        // Topic unresolvable (e.g. Apollo-config sourced) — surface, never drop (R5).
        consumes.push({
          kind: 'mq',
          key: 'topic:?',
          role: 'consumer',
          nodeId,
          confidence: 0.3,
          unresolvedTopic: true,
          evidence: `extends ${consumerBase}; topic source unresolved (literal/in-file constant not found)`,
          line: cls.line,
        });
      }
    }
  }

  return { provides, consumes };
}
