// Left-pane (system overview) state, kept in its OWN store so it never collides
// with the single-repo dashboard store that drives the right pane.
import { create } from "zustand";
import type { SystemGraph } from "@understand-anything/core/types";

export type SystemSelection =
  | { kind: "service"; id: string }
  | { kind: "edge"; id: string }
  | null;

interface SystemStore {
  systemGraph: SystemGraph | null;
  selected: SystemSelection;
  setSystemGraph: (graph: SystemGraph) => void;
  selectService: (id: string) => void;
  selectEdge: (id: string) => void;
  clearSelection: () => void;
}

export const useSystemStore = create<SystemStore>()((set) => ({
  systemGraph: null,
  selected: null,
  setSystemGraph: (graph) => set({ systemGraph: graph, selected: null }),
  selectService: (id) => set({ selected: { kind: "service", id } }),
  selectEdge: (id) => set({ selected: { kind: "edge", id } }),
  clearSelection: () => set({ selected: null }),
}));
