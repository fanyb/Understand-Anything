import { describe, it, expect } from "vitest";
import { validateSystemGraph } from "../schema";
import type { SystemGraph } from "../types";

/** A minimal but complete, valid system graph. */
function validGraph(): SystemGraph {
  return {
    version: "1.0.0",
    kind: "system",
    services: [
      { id: "aurora-service", repo: "aurora", domains: ["派单"], graphRef: "aurora-service/.understand-anything/knowledge-graph.json", stats: { nodes: 10, edges: 20 } },
      { id: "backend-aurora", repo: "aurora", domains: ["派单"], graphRef: "backend-aurora/.understand-anything/knowledge-graph.json", stats: { nodes: 5, edges: 8 } },
    ],
    domains: [
      { id: "domain:派单", name: "派单", serviceIds: ["aurora-service", "backend-aurora"] },
    ],
    edges: [
      {
        id: "x1", type: "calls", protocol: "dubbo", domain: "派单",
        sourceService: "backend-aurora", targetService: "aurora-service",
        key: "com.hk.X#queryPlan",
        from: { graphRef: "backend-aurora/.understand-anything/knowledge-graph.json", nodeId: "file:backend-aurora/A.java" },
        to: { graphRef: "aurora-service/.understand-anything/knowledge-graph.json", nodeId: "file:aurora-service/B.java" },
        confidence: 1, evidence: "@DubboReference",
      },
      { id: "f1", type: "flow", domain: "派单", sequence: ["backend-aurora", "aurora-service"], via: ["dubbo"] },
    ],
    unresolved: [
      { kind: "http", key: "POST /crm/x", consumerService: "backend-aurora", nodeId: "file:backend-aurora/C.java", reason: "no provider" },
    ],
  };
}

describe("validateSystemGraph", () => {
  it("accepts a valid system graph and preserves it", () => {
    const res = validateSystemGraph(validGraph());
    expect(res.success).toBe(true);
    expect(res.fatal).toBeUndefined();
    expect(res.data?.services).toHaveLength(2);
    expect(res.data?.domains).toHaveLength(1);
    expect(res.data?.edges).toHaveLength(2);
    expect(res.data?.unresolved).toHaveLength(1);
    expect(res.issues).toHaveLength(0);
  });

  it("rejects non-objects", () => {
    expect(validateSystemGraph(null).success).toBe(false);
    expect(validateSystemGraph("x").success).toBe(false);
    expect(validateSystemGraph(42).fatal).toMatch(/not an object/);
  });

  it("rejects a graph whose kind is not 'system'", () => {
    const g = { ...validGraph(), kind: "codebase" };
    const res = validateSystemGraph(g);
    expect(res.success).toBe(false);
    expect(res.fatal).toMatch(/kind: "system"/);
  });

  it("treats a non-array top-level collection as fatal", () => {
    const g = { ...validGraph(), edges: {} as unknown };
    const res = validateSystemGraph(g);
    expect(res.success).toBe(false);
    expect(res.fatal).toMatch(/"edges" must be an array/);
  });

  it("is fatal when no valid services remain", () => {
    const g = { ...validGraph(), services: [{ id: "x" }] };
    const res = validateSystemGraph(g);
    expect(res.success).toBe(false);
    expect(res.fatal).toMatch(/No valid services/);
  });

  it("drops a malformed edge but keeps the valid ones (drop-broken)", () => {
    const g = validGraph();
    // An edge with an unknown type cannot match the discriminated union → dropped.
    (g.edges as unknown[]).push({ id: "bad", type: "mystery" });
    const res = validateSystemGraph(g);
    expect(res.success).toBe(true);
    expect(res.data?.edges).toHaveLength(2); // the two valid edges survive
    expect(res.issues.some((i) => i.level === "dropped" && i.path === "edges[2]")).toBe(true);
  });

  it("accepts a calls edge whose from/to graphRef is null", () => {
    const g = validGraph();
    (g.edges[0] as { from: { graphRef: string | null } }).from.graphRef = null;
    const res = validateSystemGraph(g);
    expect(res.success).toBe(true);
    const x1 = res.data?.edges.find((e) => e.id === "x1");
    expect(x1?.type).toBe("calls");
    expect((x1 as { from: { graphRef: string | null } }).from.graphRef).toBeNull();
  });

  it("accepts a calls edge with no domain field", () => {
    const g = validGraph();
    delete (g.edges[0] as { domain?: string }).domain;
    const res = validateSystemGraph(g);
    expect(res.success).toBe(true);
    expect(res.data?.edges.find((e) => e.id === "x1")).toBeDefined();
  });
});
