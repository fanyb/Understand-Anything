#!/usr/bin/env node
/**
 * extractors/mq.mjs  —  v0.2 (+ real-source-aligned topic resolution)
 *
 * MQ boundary extractor for this project's *self-wrapped* RocketMQ (DESIGN.md
 * §6.1: no standard `@RocketMQMessageListener` / `rocketMQTemplate`).
 *
 * REALITY CHECK (verified against aurora-service, DESIGN.md §13): the topic is
 * NOT in the Java source — it is Apollo/config-sourced.
 *   - Producer: `MqSendService` exposes named methods (e.g. `sendAnalysisNoticed`)
 *     and reads the topic from `@Value("${mq.rocket-mq.producerTopic_*}")` String
 *     fields. The topic *value* lives in Apollo; only the *property key* is static.
 *   - Consumer: `extends AbstractRocketMqHandler` with a single
 *     `handleMessage(MessageExt)` and NO `getTopic()`. The handler→topic binding
 *     is entirely external (`mq.rocket-mq.handlerConfig` maps tag→handler FQN,
 *     `consumeTopics` lists topics). Only the handler *FQN* is static.
 *
 * So the only deterministic source-side handles are the producer's `@Value`
 * property key and the consumer's handler FQN. The real topic value is supplied
 * by the user in the manifest (same principle as the gateway prefix / base path,
 * DESIGN.md §13 decision ①):
 *   mq.topics.byProp:    { "mq.rocket-mq.producerTopic_x": "TOPIC_NAME" }
 *   mq.topics.byHandler: { "com.x.FooHandler":            "TOPIC_NAME" }
 *
 * Resolution order (most reliable first):
 *   provides (producer): (1) literal/in-file-const `<MqSendService>.send("T", …)`;
 *     (2) `@Value("${KEY}")` topic field in the producer class → mq.topics.byProp[KEY].
 *     An unresolved property key is surfaced as `topicProp:KEY` (never guessed).
 *   consumes (consumer): a class `extends <consumerBase>`. Topic from
 *     (1) mq.topics.byHandler[FQN]; (2) a `getTopic()`/`super(…)` literal/const.
 *     Unresolved → `topic:?` with the handler FQN, so it lands in `unresolved` (R5).
 *
 * Producer and consumer of the same topic join on `topic:NAME`, yielding a
 * cross-service edge in the consumer→producer (dependency) direction — the same
 * convention as Dubbo/HTTP. The base/send class names are per-service configurable
 * (`mq.consumerBaseClass` / `mq.producerClass`).
 *
 * Pure module: `extract(files, ctx)` takes pre-read files and returns boundary
 * fragments. Disk walking lives in extract-boundaries.mjs.
 */

import { scanJava, firstStringArg } from './java-scan.mjs';

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
 * Producer topic *property keys* declared as `@Value("${KEY[:default]}")` String
 * fields inside the producer class. Tag/credential props are excluded — only keys
 * mentioning "topic" (and not "tag") are treated as topics.
 * @returns {Array<{propKey:string, line:number}>}
 */
function producerTopicProps(scan) {
  const out = [];
  for (const f of scan.fields) {
    const v = f.annotations.find((a) => a.name === 'Value');
    if (!v) continue;
    const arg = firstStringArg(v.raw);
    if (!arg) continue;
    const m = arg.match(/^\$\{([^:}]+)(?::[^}]*)?\}$/); // ${key} or ${key:default}
    if (!m) continue;
    const propKey = m[1];
    if (!/topic/i.test(propKey) || /tag/i.test(propKey)) continue;
    out.push({ propKey, line: f.line });
  }
  return out;
}

/**
 * @param {Array<{path:string, content:string}>} files  service source files
 * @param {{serviceId:string, domains?:string[], mq?:{consumerBaseClass?:string, producerClass?:string, topics?:{byProp?:Record<string,string>, byHandler?:Record<string,string>}}}} ctx
 * @returns {{provides:Array, consumes:Array}}
 */
export function extract(files, ctx = {}) {
  const provides = [];
  const consumes = [];
  const domain = soleDomain(ctx.domains);
  const consumerBase = ctx.mq?.consumerBaseClass || DEFAULT_CONSUMER_BASE;
  const producerClass = ctx.mq?.producerClass || DEFAULT_PRODUCER_CLASS;
  const producerHint = producerClass.toLowerCase();
  const topicsByProp = ctx.mq?.topics?.byProp || {};
  const topicsByHandler = ctx.mq?.topics?.byHandler || {};

  const sendRe = /\b([A-Za-z_]\w*)\s*\.\s*send\s*\(\s*([^,;)]+)/g;

  for (const { path, content } of files) {
    if (!path.endsWith('.java')) continue;
    const nodeId = `file:${path}`;
    const consts = collectStringConstants(content);
    const scan = scanJava(content);

    // --- producers (A): literal/in-file-const <MqSendService>.send("TOPIC", …) ---
    let m;
    sendRe.lastIndex = 0;
    while ((m = sendRe.exec(content))) {
      const recv = m[1];
      const isMqSend =
        recv === producerClass || recv.toLowerCase() === producerHint || recv.toLowerCase().includes('mqsend');
      if (!isMqSend) continue;
      const resolved = resolveTopicArg(m[2], consts);
      if (!resolved) continue; // unknown-topic call site: no join path, skip
      const p = {
        kind: 'mq',
        key: `topic:${resolved.topic}`,
        role: 'producer',
        nodeId,
        confidence: resolved.via === 'literal' ? 0.9 : 0.8,
        via: resolved.via,
        evidence: `${recv}.send(${resolved.via === 'literal' ? `"${resolved.topic}"` : m[2].trim()})`,
        line: lineOf(content, m.index),
      };
      if (domain) p.domain = domain;
      provides.push(p);
    }

    // --- producers (B): @Value("${...topic...}") fields inside the producer class ---
    // (the real aurora shape — topic value supplied via manifest mq.topics.byProp)
    if (scan.classes.some((c) => c.name === producerClass)) {
      for (const { propKey, line } of producerTopicProps(scan)) {
        const topic = topicsByProp[propKey];
        if (topic) {
          const p = {
            kind: 'mq',
            key: `topic:${topic}`,
            role: 'producer',
            nodeId,
            confidence: 0.85,
            via: 'config',
            evidence: `@Value(${propKey}) → ${topic} (manifest mq.topics.byProp)`,
            line,
          };
          if (domain) p.domain = domain;
          provides.push(p);
        } else {
          // Property key is static but its topic value is Apollo-sourced and not in
          // the manifest — surface it (distinct `topicProp:` key never joins), R5.
          provides.push({
            kind: 'mq',
            key: `topicProp:${propKey}`,
            role: 'producer',
            nodeId,
            confidence: 0.3,
            unresolvedTopic: true,
            evidence: `@Value(${propKey}); topic value not in manifest mq.topics.byProp (Apollo-sourced)`,
            line,
          });
        }
      }
    }

    // --- consumers: class extends <consumerBase> ---
    for (const cls of scan.classes) {
      if (cls.extendsName !== consumerBase) continue;
      const fqn = scan.packageName ? `${scan.packageName}.${cls.name}` : cls.name;

      let topic = null;
      let via = null;
      if (topicsByHandler[fqn]) {
        topic = topicsByHandler[fqn];
        via = 'config';
      } else {
        const r = resolveConsumerTopic(content, consts);
        if (r) {
          topic = r.topic;
          via = r.via;
        }
      }

      if (topic) {
        consumes.push({
          kind: 'mq',
          key: `topic:${topic}`,
          role: 'consumer',
          nodeId,
          confidence: via === 'config' ? 0.85 : via === 'literal' ? 0.9 : 0.8,
          via,
          evidence:
            via === 'config'
              ? `extends ${consumerBase}; ${fqn} → ${topic} (manifest mq.topics.byHandler)`
              : `extends ${consumerBase} (topic ${via})`,
          line: cls.line,
        });
      } else {
        // Topic config-sourced (Apollo) and not in the manifest — surface, never drop (R5).
        consumes.push({
          kind: 'mq',
          key: 'topic:?',
          role: 'consumer',
          nodeId,
          confidence: 0.3,
          unresolvedTopic: true,
          handlerFqn: fqn,
          evidence: `extends ${consumerBase}; topic config-sourced (Apollo). Add "${fqn}" to manifest mq.topics.byHandler`,
          line: cls.line,
        });
      }
    }
  }

  return { provides, consumes };
}
