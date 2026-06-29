import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "../store";
import { useSystemStore } from "../systemStore";

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

beforeEach(() => {
  useDashboardStore.setState({
    graph: null,
    serviceGraphCache: new Map(),
    activeServiceRef: null,
    serviceLoadError: null,
    selectedNodeId: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("loadServiceGraph (right-pane drill-down)", () => {
  it("fetches, validates, caches, and sets the right-pane graph", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => validKnowledgeGraph() }));
    vi.stubGlobal("fetch", fetchMock);
    await useDashboardStore.getState().loadServiceGraph("refA", { accessToken: "t" });
    const s = useDashboardStore.getState();
    expect(s.activeServiceRef).toBe("refA");
    expect(s.graph?.nodes).toHaveLength(1);
    expect(s.serviceGraphCache.has("refA")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-fetch on a cache hit", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => validKnowledgeGraph() }));
    vi.stubGlobal("fetch", fetchMock);
    await useDashboardStore.getState().loadServiceGraph("refA", { accessToken: "t" });
    await useDashboardStore.getState().loadServiceGraph("refA", { accessToken: "t" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().activeServiceRef).toBe("refA");
  });

  it("selects the drill-anchor node after load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => validKnowledgeGraph() })));
    await useDashboardStore.getState().loadServiceGraph("refA", { selectNodeId: "n0", accessToken: "t" });
    expect(useDashboardStore.getState().selectedNodeId).toBe("n0");
  });

  it("records an error and leaves the graph untouched on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    await useDashboardStore.getState().loadServiceGraph("refBad", { accessToken: "t" });
    const s = useDashboardStore.getState();
    expect(s.serviceLoadError).toMatch(/403/);
    expect(s.graph).toBeNull();
  });
});

describe("systemStore (left-pane selection)", () => {
  beforeEach(() => useSystemStore.setState({ systemGraph: null, selected: null }));

  it("selecting a service then an edge replaces the selection", () => {
    useSystemStore.getState().selectService("aurora-service");
    expect(useSystemStore.getState().selected).toEqual({ kind: "service", id: "aurora-service" });
    useSystemStore.getState().selectEdge("x1");
    expect(useSystemStore.getState().selected).toEqual({ kind: "edge", id: "x1" });
    useSystemStore.getState().clearSelection();
    expect(useSystemStore.getState().selected).toBeNull();
  });

  it("setSystemGraph clears any prior selection", () => {
    useSystemStore.getState().selectService("x");
    useSystemStore.getState().setSystemGraph({ version: "1.0.0", kind: "system", services: [], domains: [], edges: [], unresolved: [] });
    expect(useSystemStore.getState().selected).toBeNull();
  });
});
