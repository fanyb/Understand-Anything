#!/usr/bin/env node
/**
 * java-scan.mjs
 *
 * Lightweight, deterministic Java source scanner for the boundary extractors.
 *
 * The shared @understand-anything/core JavaExtractor surfaces classes / methods /
 * fields / imports but NOT annotations, `implements` lists, or the package
 * declaration — exactly the signals Dubbo / Spring-MVC boundary extraction needs.
 * Extending the shared `StructuralAnalysis` type just for this skill would be a
 * non-surgical change to a browser-safe core package, so this scanner is kept
 * self-contained inside the skill.
 *
 * It is line-based with a pending-annotation buffer rather than a full parser:
 * cheap, deterministic, and good enough for the regular shape of annotated
 * Dubbo / Spring declarations. Known v0.1 limitations (documented, acceptable):
 *   - Annotation argument lists must fit on one line (`@X(... )` not split).
 *   - Only the first quoted string in an annotation is read as its path/value.
 *   - Nested-paren annotation args (e.g. `methods = {@Method(...)}`) are not parsed.
 *
 * Pure module — no I/O. `scanJava(content)` is the only entry point.
 */

/** Strip a trailing `// ...` line comment, ignoring `//` inside string literals. */
function stripLineComment(line) {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** `import a.b.C;` → record simpleName→FQN. Static imports are ignored. */
function addImport(imports, line) {
  const m = line.match(/^import\s+(?:static\s+)?([\w.]+)\s*;/);
  if (!m) return;
  const fqn = m[1];
  if (fqn.endsWith('.*')) return; // wildcard: cannot resolve a simple name
  const simple = fqn.split('.').pop();
  imports[simple] = fqn;
}

/** Pull `implements A, B<C>` and `extends D` out of a class/interface header. */
function parseHeader(header) {
  let implementsList = [];
  let extendsName = null;

  const implM = header.match(/\bimplements\s+([^{]+?)(?:\bextends\b|\{|$)/);
  if (implM) {
    implementsList = splitTypeList(implM[1]);
  }
  const extM = header.match(/\bextends\s+([\w.]+(?:<[^>]*>)?)/);
  if (extM) {
    extendsName = stripGenerics(extM[1]).split('.').pop();
  }
  return { implementsList, extendsName };
}

/** "A, B<X>, c.d.E" → ["A", "B", "E"] (generics stripped, simple names). */
function splitTypeList(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(simpleType(cur));
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(simpleType(cur));
  return out.filter(Boolean);
}

function stripGenerics(s) {
  return s.replace(/<[^>]*>/g, '').trim();
}

function simpleType(s) {
  return stripGenerics(s).trim().split('.').pop();
}

/**
 * Scan Java source.
 *
 * @returns {{
 *   packageName: string,
 *   imports: Record<string,string>,        // simpleName → FQN
 *   classes: Array<{name,kind,annotations,implementsList,extendsName,line}>,
 *   fields: Array<{type,name,annotations,line}>,
 *   methods: Array<{name,annotations,line}>,
 * }}
 * Each `annotations` entry is `{name, raw, line}` where `name` is the simple
 * annotation name (e.g. "DubboService") and `raw` is the full text incl. args.
 */
export function scanJava(content) {
  const lines = content.split('\n');
  let packageName = '';
  const imports = {};
  const classes = [];
  const fields = [];
  const methods = [];
  let buffer = []; // pending annotations {name, raw, line}

  for (let i = 0; i < lines.length; i++) {
    const line = stripLineComment(lines[i]).trim();
    if (!line) continue;                                  // blank — keep buffer
    if (line.startsWith('//')) continue;                  // comment — keep buffer
    if (line.startsWith('*') || line.startsWith('/*')) continue; // block comment — keep buffer

    if (line.startsWith('package ')) {
      packageName = line.slice('package '.length).replace(';', '').trim();
      continue;
    }
    if (line.startsWith('import ')) {
      addImport(imports, line);
      continue;
    }

    // Peel leading annotations off the line (there may be several, and a
    // declaration may follow on the same line, e.g. `@DubboReference private Foo f;`).
    let rest = line;
    let m;
    while ((m = rest.match(/^@([\w.]+)\s*(\([^)]*\))?/))) {
      const name = m[1].split('.').pop();
      buffer.push({ name, raw: '@' + m[1] + (m[2] || ''), line: i + 1 });
      rest = rest.slice(m[0].length).trim();
      if (!rest) break;
    }
    if (!rest) continue; // line was annotations only

    // class / interface / enum declaration
    const classMatch = rest.match(/\b(class|interface|enum)\s+(\w+)/);
    if (classMatch) {
      const declLine = i + 1;
      // Accumulate the header until '{' so a multi-line implements list is captured.
      let header = rest;
      let j = i;
      while (!header.includes('{') && j + 1 < lines.length && j - i < 6) {
        j++;
        header += ' ' + stripLineComment(lines[j]).trim();
      }
      i = j;
      const { implementsList, extendsName } = parseHeader(header);
      classes.push({
        name: classMatch[2],
        kind: classMatch[1],
        annotations: buffer,
        implementsList,
        extendsName,
        line: declLine,
      });
      buffer = [];
      continue;
    }

    // method declaration: an identifier immediately followed by '(' .
    if (/\b\w+\s*\(/.test(rest)) {
      const nameM = rest.match(/(\w+)\s*\(/);
      methods.push({ name: nameM ? nameM[1] : '', annotations: buffer, line: i + 1 });
      buffer = [];
      continue;
    }

    // field declaration: `[modifiers] Type name [;=]`
    const fieldM = rest.match(
      /^(?:(?:private|protected|public|static|final|transient|volatile)\s+)*([A-Za-z_][\w.]*)(?:<[^>]*>)?\s+([A-Za-z_]\w*)\s*[;=]/,
    );
    if (fieldM) {
      fields.push({
        type: fieldM[1].split('.').pop(),
        name: fieldM[2],
        annotations: buffer,
        line: i + 1,
      });
      buffer = [];
      continue;
    }

    // Unrecognized code line — drop any stranded annotations.
    buffer = [];
  }

  return { packageName, imports, classes, fields, methods };
}

/**
 * Resolve a simple type name to a fully-qualified name using the file's imports,
 * falling back to a same-package guess.
 *
 * @returns {{fqn: string, confidence: number}} confidence 1.0 when resolved via
 *   an explicit import, 0.7 for a same-package guess, 0.5 when unresolved.
 */
export function resolveFqn(simpleName, scan) {
  if (scan.imports[simpleName]) {
    return { fqn: scan.imports[simpleName], confidence: 1.0 };
  }
  if (scan.packageName) {
    return { fqn: `${scan.packageName}.${simpleName}`, confidence: 0.7 };
  }
  return { fqn: simpleName, confidence: 0.5 };
}

/** True if the annotation buffer contains an annotation with the given simple name. */
export function hasAnnotation(annotations, name) {
  return annotations.some((a) => a.name === name);
}

/** Return the annotation object with the given simple name, or null. */
export function getAnnotation(annotations, name) {
  return annotations.find((a) => a.name === name) || null;
}

/** First quoted string literal inside an annotation's args, or null. */
export function firstStringArg(raw) {
  const m = raw.match(/["']([^"']*)["']/);
  return m ? m[1] : null;
}
