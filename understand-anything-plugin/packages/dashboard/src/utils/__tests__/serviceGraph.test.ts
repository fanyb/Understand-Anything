import { describe, it, expect, vi, afterEach } from "vitest";
import { serviceGraphUrl, fetchAndValidateServiceGraph } from "../serviceGraph";

function validKnowledgeGraph() {
  return {
    version: "1.0.0",
    project: { name: "svc", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [{ id: "n0", type: "file", name: "A.java", filePath: "src/A.java", summary: "a", tags: [], complexity: "simple" }],
    edges: [],
    layers: [],
    tour: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serviceGraphUrl", () => {
  it("encodes ref and includes the token", () => {
    const u = serviceGraphUrl("../sib/.understand-anything/knowledge-graph.json", "tok");
    expect(u).toContain("/service-graph.json?");
    expect(u).toContain("token=tok");
    expect(u).toContain("ref=");
    // The ../ must be percent-encoded, not passed raw.
    expect(u).not.toContain("../sib");
  });
  it("omits the token when null", () => {
    expect(serviceGraphUrl("a", null)).not.toContain("token=");
  });
});

describe("fetchAndValidateServiceGraph", () => {
  it("returns the validated graph on success", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => validKnowledgeGraph() }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchAndValidateServiceGraph("ref", "tok");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.graph.nodes).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("errors on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    const r = await fetchAndValidateServiceGraph("ref", "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/403/);
  });

  it("errors when the body fails graph validation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ not: "a graph" }) })));
    const r = await fetchAndValidateServiceGraph("ref", "tok");
    expect(r.ok).toBe(false);
  });

  it("errors when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await fetchAndValidateServiceGraph("ref", "tok");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/network down/);
  });
});
