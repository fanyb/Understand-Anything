import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import {
  collectAllowedRefs,
  loadAllowedRefs,
  resolveAllowedRef,
  readSystemGraph,
  readServiceGraph,
  readServiceDomainGraph,
  readServiceFile,
  readSourceFile,
} from "../graphFiles";

/** Lay down a service: knowledge-graph.json listing files + the actual source files. */
function makeService(serviceDir: string, files: Array<{ rel: string; content: string }>, withDomain = false) {
  mkdirSync(join(serviceDir, ".understand-anything"), { recursive: true });
  writeFileSync(
    join(serviceDir, ".understand-anything/knowledge-graph.json"),
    JSON.stringify({
      version: "1.0.0",
      project: { name: serviceDir },
      nodes: files.map((f, i) => ({ id: `n${i}`, type: "file", name: f.rel, filePath: f.rel })),
      edges: [],
    }),
  );
  if (withDomain) {
    writeFileSync(
      join(serviceDir, ".understand-anything/domain-graph.json"),
      JSON.stringify({ version: "1.0.0", nodes: [], edges: [] }),
    );
  }
  for (const f of files) {
    mkdirSync(dirname(join(serviceDir, f.rel)), { recursive: true });
    writeFileSync(join(serviceDir, f.rel), f.content);
  }
}

let T: string;
let linkDir: string;
const refA = "aurora-service/.understand-anything/knowledge-graph.json";
const refB = "../backend-aurora/.understand-anything/knowledge-graph.json"; // sibling, exercises ../

beforeAll(() => {
  T = mkdtempSync(join(tmpdir(), "ua-srv-"));
  linkDir = join(T, "workspace");
  mkdirSync(join(linkDir, ".understand-link"), { recursive: true });
  makeService(join(linkDir, "aurora-service"), [{ rel: "src/A.java", content: "class A {}\n" }], true);
  makeService(join(T, "backend-aurora"), [{ rel: "src/B.java", content: "class B {}\n" }], false);

  const systemGraph = {
    version: "1.0.0",
    kind: "system",
    services: [
      { id: "aurora-service", repo: "aurora", domains: [], graphRef: refA, stats: { nodes: 1, edges: 0 } },
      { id: "backend-aurora", repo: "aurora", domains: [], graphRef: refB, stats: { nodes: 1, edges: 0 } },
    ],
    domains: [],
    edges: [
      { id: "x1", type: "calls", protocol: "dubbo", sourceService: "backend-aurora", targetService: "aurora-service", key: "k",
        from: { graphRef: refB, nodeId: "n0" }, to: { graphRef: refA, nodeId: "n0" }, confidence: 1, evidence: "" },
      // An edge whose from.graphRef is null — must be excluded from the allowlist.
      { id: "x2", type: "calls", protocol: "http", sourceService: "x", targetService: "aurora-service", key: "k2",
        from: { graphRef: null, nodeId: "n0" }, to: { graphRef: refA, nodeId: "n0" }, confidence: 1, evidence: "" },
    ],
    unresolved: [],
  };
  writeFileSync(join(linkDir, ".understand-link/system-graph.json"), JSON.stringify(systemGraph));
});

afterAll(() => rmSync(T, { recursive: true, force: true }));

describe("allowlist (collectAllowedRefs / loadAllowedRefs / resolveAllowedRef)", () => {
  it("collects service + edge graphRefs and excludes null", () => {
    const refs = loadAllowedRefs(linkDir)!;
    expect(refs.has(refA)).toBe(true);
    expect(refs.has(refB)).toBe(true);
    expect([...refs].some((r) => r === null || r === "null")).toBe(false);
    expect(refs.size).toBe(2); // refA, refB — the null endpoint is dropped
  });

  it("collectAllowedRefs is pure over a parsed object", () => {
    const refs = collectAllowedRefs({ services: [{ graphRef: "a" }], edges: [{ from: { graphRef: "b" }, to: { graphRef: null } }] });
    expect([...refs].sort()).toEqual(["a", "b"]);
  });

  it("returns null when there is no workspace / system graph", () => {
    expect(loadAllowedRefs(null)).toBeNull();
    expect(loadAllowedRefs(join(T, "does-not-exist"))).toBeNull();
  });

  it("resolves only EXACT, un-normalized members", () => {
    const allowed = loadAllowedRefs(linkDir);
    expect(resolveAllowedRef(linkDir, refA, allowed)).toBe(resolve(linkDir, refA));
    expect(resolveAllowedRef(linkDir, refB, allowed)).toBe(resolve(linkDir, refB)); // ../ ok
    // A ref that normalizes to an allowed path but isn't a literal member is rejected.
    expect(resolveAllowedRef(linkDir, "./" + refA, allowed)).toBeNull();
    expect(resolveAllowedRef(linkDir, "nope/kg.json", allowed)).toBeNull();
    expect(resolveAllowedRef(linkDir, null, allowed)).toBeNull();
    expect(resolveAllowedRef(linkDir, refA, null)).toBeNull();
  });
});

describe("readSystemGraph", () => {
  it("serves the system graph", () => {
    const r = readSystemGraph(linkDir) as { statusCode: number; payload: { services: unknown[] } };
    expect(r.statusCode).toBe(200);
    expect(r.payload.services).toHaveLength(2);
  });
  it("404s without a workspace", () => {
    expect(readSystemGraph(null).statusCode).toBe(404);
  });
});

describe("readServiceGraph", () => {
  it("serves a service graph by ref (incl. ../ sibling)", () => {
    const allowed = loadAllowedRefs(linkDir);
    const a = readServiceGraph(linkDir, refA, allowed) as { statusCode: number; payload: { nodes: unknown[] } };
    expect(a.statusCode).toBe(200);
    expect(a.payload.nodes).toHaveLength(1);
    const b = readServiceGraph(linkDir, refB, allowed) as { statusCode: number; payload: { nodes: unknown[] } };
    expect(b.statusCode).toBe(200);
    expect(b.payload.nodes).toHaveLength(1);
  });
  it("rejects a ref not in the allowlist", () => {
    expect(readServiceGraph(linkDir, "evil/kg.json", loadAllowedRefs(linkDir)).statusCode).toBe(403);
  });
});

describe("readServiceDomainGraph", () => {
  it("serves a sibling domain-graph.json when present", () => {
    expect(readServiceDomainGraph(linkDir, refA, loadAllowedRefs(linkDir)).statusCode).toBe(200);
  });
  it("404s when the service has no domain graph", () => {
    expect(readServiceDomainGraph(linkDir, refB, loadAllowedRefs(linkDir)).statusCode).toBe(404);
  });
});

describe("readServiceFile", () => {
  it("serves a file within the service, scoped to its graph allowlist", () => {
    const r = readServiceFile(linkDir, refA, "src/A.java", loadAllowedRefs(linkDir)) as { statusCode: number; payload: { content: string } };
    expect(r.statusCode).toBe(200);
    expect(r.payload.content).toBe("class A {}\n");
  });
  it("serves a file from a ../ sibling service", () => {
    const r = readServiceFile(linkDir, refB, "src/B.java", loadAllowedRefs(linkDir)) as { statusCode: number; payload: { content: string } };
    expect(r.statusCode).toBe(200);
    expect(r.payload.content).toBe("class B {}\n");
  });
  it("rejects path traversal", () => {
    expect(readServiceFile(linkDir, refA, "../../../etc/passwd", loadAllowedRefs(linkDir)).statusCode).toBe(400);
  });
  it("rejects absolute paths", () => {
    expect(readServiceFile(linkDir, refA, "/etc/passwd", loadAllowedRefs(linkDir)).statusCode).toBe(400);
  });
  it("404s for a file not in the service graph allowlist", () => {
    expect(readServiceFile(linkDir, refA, "src/Secret.java", loadAllowedRefs(linkDir)).statusCode).toBe(404);
  });
  it("rejects a ref not in the allowlist", () => {
    expect(readServiceFile(linkDir, "evil/kg.json", "src/A.java", loadAllowedRefs(linkDir)).statusCode).toBe(403);
  });
});

describe("single-repo readSourceFile (regression — env-discovered)", () => {
  let single: string;
  beforeAll(() => {
    single = mkdtempSync(join(tmpdir(), "ua-single-"));
    makeService(single, [{ rel: "src/Main.ts", content: "export const x = 1;\n" }]);
    process.env.GRAPH_DIR = single;
  });
  afterAll(() => {
    delete process.env.GRAPH_DIR;
    rmSync(single, { recursive: true, force: true });
  });

  it("serves an allowed file", () => {
    const r = readSourceFile("src/Main.ts") as { statusCode: number; payload: { content: string } };
    expect(r.statusCode).toBe(200);
    expect(r.payload.content).toBe("export const x = 1;\n");
  });
  it("rejects traversal and empty path", () => {
    expect(readSourceFile("../escape").statusCode).toBe(400);
    expect(readSourceFile("").statusCode).toBe(400);
  });
  it("404s for a file outside the graph allowlist", () => {
    expect(readSourceFile("src/Other.ts").statusCode).toBe(404);
  });
});
