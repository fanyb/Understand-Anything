// Server-only file logic for the dashboard dev server (single-repo + multi-repo).
//
// This lives OUTSIDE src/ on purpose: src is type-checked by tsconfig.app.json with
// a DOM-only lib and no @types/node, so node:fs/path here would not type-check
// there. vite.config.ts (also outside src) imports this; vitest transforms it via
// esbuild. Keep it free of any browser import.
//
// Security model is unchanged from the original inline vite.config.ts logic:
//   - token gate (handled by the caller)
//   - per-file: no null byte, no absolute path, no `..` escape, must be in the
//     owning graph's filePath allowlist, ≤1MB, not binary
// Multi-repo adds: a service graph is addressed by its `graphRef` (relative to the
// workspace root, may contain `../`); `ref` must be an EXACT, un-normalized member
// of the set of graphRefs declared in system-graph.json.

import fs from "node:fs";
import path from "node:path";

export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
export const SYSTEM_GRAPH_REL = ".understand-link/system-graph.json";

export interface FileResult {
  statusCode: number;
  payload: unknown;
}

function rejectFileRequest(message: string, statusCode = 400): FileResult {
  return { statusCode, payload: { error: message } };
}

// ---------------------------------------------------------------------------
// Single-repo discovery (env-coupled; behavior preserved verbatim)
// ---------------------------------------------------------------------------

export function graphFileCandidates(fileName: string): string[] {
  const graphDir = process.env.GRAPH_DIR;
  return [
    ...(graphDir ? [path.resolve(graphDir, `.understand-anything/${fileName}`)] : []),
    path.resolve(process.cwd(), `.understand-anything/${fileName}`),
    path.resolve(process.cwd(), `../../../.understand-anything/${fileName}`),
  ];
}

export function findGraphFile(fileName: string): string | null {
  return graphFileCandidates(fileName).find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function projectRootFromGraphFile(candidate: string): string {
  return path.dirname(path.dirname(candidate));
}

// ---------------------------------------------------------------------------
// Pure path safety / sanitization (shared by single-repo and per-service)
// ---------------------------------------------------------------------------

export function normalizeGraphPath(filePath: string, projectRoot: string): string | null {
  const rawPath = path.isAbsolute(filePath)
    ? filePath.startsWith(projectRoot)
      ? path.relative(projectRoot, filePath)
      : null
    : filePath;
  if (rawPath === null) return null;
  const normalized = path.normalize(rawPath);
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized.split(path.sep).join("/");
}

export function graphFilePathSet(graphFile: string, projectRoot: string): Set<string> {
  const allowed = new Set<string>();
  try {
    const raw = JSON.parse(fs.readFileSync(graphFile, "utf-8")) as {
      nodes?: Array<Record<string, unknown>>;
    };
    for (const node of raw.nodes ?? []) {
      if (typeof node.filePath !== "string") continue;
      const normalized = normalizeGraphPath(node.filePath, projectRoot);
      if (normalized) allowed.add(normalized);
    }
  } catch {
    return allowed;
  }
  return allowed;
}

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const byExt: Record<string, string> = {
    bash: "bash", c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css",
    go: "go", h: "c", hpp: "cpp", html: "markup", java: "java", js: "javascript",
    jsx: "jsx", json: "json", md: "markdown", mjs: "javascript", py: "python",
    rb: "ruby", rs: "rust", sh: "bash", ts: "typescript", tsx: "tsx",
    txt: "text", yaml: "yaml", yml: "yaml",
  };
  return byExt[ext] ?? "text";
}

/** Relativize node filePaths so the developer's absolute directory layout is not leaked. */
export function sanitizeGraphJson(
  raw: { nodes?: Array<Record<string, unknown>>; [key: string]: unknown },
  projectRoot: string,
): unknown {
  if (raw && Array.isArray(raw.nodes)) {
    raw.nodes = raw.nodes.map((node) => {
      if (typeof node.filePath !== "string") return node;
      const abs = node.filePath;
      const rel = abs.startsWith(projectRoot)
        ? abs.slice(projectRoot.length).replace(/^[\\/]/, "")
        : path.isAbsolute(abs)
        ? path.basename(abs) // absolute but outside root — use filename only
        : abs; // already relative — keep as-is
      return { ...node, filePath: rel };
    });
  }
  return raw;
}

/** Read + parse + sanitize a graph JSON file (knowledge-graph.json or domain-graph.json). */
export function readAndSanitizeGraph(absFile: string): FileResult {
  try {
    const raw = JSON.parse(fs.readFileSync(absFile, "utf-8"));
    return { statusCode: 200, payload: sanitizeGraphJson(raw, projectRootFromGraphFile(absFile)) };
  } catch {
    return { statusCode: 500, payload: { error: "Failed to read graph file" } };
  }
}

/**
 * Core source-file reader, parametrized by the owning graph + its project root so
 * single-repo and per-service drill-down share ONE security path. Contains every
 * check the original inline readSourceFile had.
 */
export function readSourceFileAt(
  projectRoot: string,
  graphFile: string,
  requestedPath: string,
): FileResult {
  if (!requestedPath) return rejectFileRequest("Missing path");
  if (requestedPath.includes("\0")) return rejectFileRequest("Invalid path");
  if (path.isAbsolute(requestedPath)) return rejectFileRequest("Absolute paths are not allowed");

  const normalizedPath = path.normalize(requestedPath);
  if (
    normalizedPath === "." ||
    normalizedPath.startsWith(`..${path.sep}`) ||
    normalizedPath === ".." ||
    path.isAbsolute(normalizedPath)
  ) {
    return rejectFileRequest("Path must stay inside the project");
  }

  const absoluteFile = path.resolve(projectRoot, normalizedPath);
  const relativeToRoot = path.relative(projectRoot, absoluteFile);
  if (
    !relativeToRoot ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    return rejectFileRequest("Path must stay inside the project");
  }
  const safeRelativePath = relativeToRoot.split(path.sep).join("/");
  if (!graphFilePathSet(graphFile, projectRoot).has(safeRelativePath)) {
    return rejectFileRequest("File is not in the knowledge graph", 404);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absoluteFile);
  } catch {
    return rejectFileRequest("File not found", 404);
  }
  if (!stat.isFile()) return rejectFileRequest("Path is not a file");
  if (stat.size > MAX_SOURCE_FILE_BYTES) return rejectFileRequest("File is too large to preview", 413);

  const buffer = fs.readFileSync(absoluteFile);
  if (buffer.includes(0)) return rejectFileRequest("Binary files cannot be previewed", 415);

  const content = buffer.toString("utf8");
  return {
    statusCode: 200,
    payload: {
      path: safeRelativePath,
      language: detectLanguage(relativeToRoot),
      content,
      sizeBytes: buffer.byteLength,
      lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length,
    },
  };
}

/** Single-repo source reader (env-discovered graph). Behavior preserved. */
export function readSourceFile(requestedPath: string): FileResult {
  const graphFile = findGraphFile("knowledge-graph.json");
  if (!graphFile) return rejectFileRequest("No knowledge graph found. Run /understand first.", 404);
  return readSourceFileAt(projectRootFromGraphFile(graphFile), graphFile, requestedPath);
}

// ---------------------------------------------------------------------------
// Multi-repo (system) mode
// ---------------------------------------------------------------------------

export function systemGraphPath(linkDir: string): string {
  return path.resolve(linkDir, SYSTEM_GRAPH_REL);
}

interface SystemGraphShape {
  services?: Array<{ graphRef?: unknown }>;
  edges?: Array<{ from?: { graphRef?: unknown }; to?: { graphRef?: unknown } }>;
}

/** The set of graphRefs the system graph declares — the drill-down allowlist. Nulls excluded. */
export function collectAllowedRefs(systemGraph: SystemGraphShape): Set<string> {
  const refs = new Set<string>();
  for (const s of systemGraph.services ?? []) {
    if (typeof s.graphRef === "string") refs.add(s.graphRef);
  }
  for (const e of systemGraph.edges ?? []) {
    if (typeof e.from?.graphRef === "string") refs.add(e.from.graphRef);
    if (typeof e.to?.graphRef === "string") refs.add(e.to.graphRef);
  }
  return refs;
}

/** Load the allowlist from disk. Returns null when the system graph is absent/unreadable. */
export function loadAllowedRefs(linkDir: string | null): Set<string> | null {
  if (!linkDir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(systemGraphPath(linkDir), "utf-8"));
    return collectAllowedRefs(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve a `ref` to an absolute graph path IFF it is an exact, UN-normalized member
 * of the allowlist. The exact-string compare (no path.normalize on either side) is
 * the security boundary that makes `../`-bearing refs safe.
 */
export function resolveAllowedRef(
  linkDir: string,
  ref: string | null,
  allowed: Set<string> | null,
): string | null {
  if (!ref || !allowed || !allowed.has(ref)) return null;
  return path.resolve(linkDir, ref);
}

/** Serve the federated system graph itself. */
export function readSystemGraph(linkDir: string | null): FileResult {
  if (!linkDir) return rejectFileRequest("No system graph workspace configured.", 404);
  const file = systemGraphPath(linkDir);
  if (!fs.existsSync(file)) {
    return rejectFileRequest("No system graph found. Run /understand-link first.", 404);
  }
  try {
    return { statusCode: 200, payload: JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch {
    return { statusCode: 500, payload: { error: "Failed to read system graph" } };
  }
}

/** Serve one service's knowledge-graph.json, addressed by its graphRef. */
export function readServiceGraph(
  linkDir: string | null,
  ref: string | null,
  allowed: Set<string> | null,
): FileResult {
  if (!linkDir) return rejectFileRequest("No system graph workspace configured.", 404);
  const absFile = resolveAllowedRef(linkDir, ref, allowed);
  if (!absFile) return rejectFileRequest("ref is not in the system graph", 403);
  if (!fs.existsSync(absFile)) return rejectFileRequest("Service graph not found", 404);
  return readAndSanitizeGraph(absFile);
}

/** Serve one service's domain-graph.json (sibling of its knowledge-graph.json). */
export function readServiceDomainGraph(
  linkDir: string | null,
  ref: string | null,
  allowed: Set<string> | null,
): FileResult {
  if (!linkDir) return rejectFileRequest("No system graph workspace configured.", 404);
  const absFile = resolveAllowedRef(linkDir, ref, allowed);
  if (!absFile) return rejectFileRequest("ref is not in the system graph", 403);
  const domainFile = path.join(path.dirname(absFile), "domain-graph.json");
  if (!fs.existsSync(domainFile)) return rejectFileRequest("Service has no domain graph", 404);
  return readAndSanitizeGraph(domainFile);
}

/** Serve a source file from within a service, scoped to that service's graph allowlist. */
export function readServiceFile(
  linkDir: string | null,
  ref: string | null,
  requestedPath: string,
  allowed: Set<string> | null,
): FileResult {
  if (!linkDir) return rejectFileRequest("No system graph workspace configured.", 404);
  const absGraphFile = resolveAllowedRef(linkDir, ref, allowed);
  if (!absGraphFile) return rejectFileRequest("ref is not in the system graph", 403);
  return readSourceFileAt(projectRootFromGraphFile(absGraphFile), absGraphFile, requestedPath);
}
