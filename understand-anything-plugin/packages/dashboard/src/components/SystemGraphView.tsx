// LEFT pane of the multi-repo "system overview" dashboard. Renders a federated
// system graph (services grouped into business-domain clusters, with cross-service
// call edges) using React Flow. Click selects; double-click a service drills into
// that service's own graph via the onDrill callback. This view is intentionally
// i18n-free for v1 (plain English literals).
import { memo, useCallback, useMemo } from "react";
import type { CSSProperties, JSX, MouseEvent as ReactMouseEvent } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
} from "@xyflow/react";
import type { Node, Edge, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useSystemStore } from "../systemStore";
import type {
  SystemService,
  SystemDomain,
  SystemCallsEdge,
} from "@understand-anything/core/types";

// --- Layout constants (manual, deterministic) ---
const SERVICE_W = 220;
const SERVICE_H = 84;
const SERVICE_GAP = 16;
const PAD = 16;
const HEADER = 40;
const GROUP_GAP = 64;

// --- Node data shapes ---
interface SystemDomainGroupData extends Record<string, unknown> {
  label: string;
}
type SystemDomainGroupFlowNode = Node<SystemDomainGroupData, "system-domain-group">;

interface SystemServiceData extends Record<string, unknown> {
  service: SystemService;
  secondaryDomains: string[];
}
type SystemServiceFlowNode = Node<SystemServiceData, "system-service">;

// --- Custom node components ---
const SystemDomainGroupNode = memo(function SystemDomainGroupNode({
  data,
}: NodeProps<SystemDomainGroupFlowNode>) {
  return (
    <div className="w-full h-full rounded-xl border border-border-subtle bg-surface/40">
      <div className="px-3 py-2 font-heading text-[11px] uppercase tracking-wider text-text-muted truncate">
        {data.label}
      </div>
    </div>
  );
});

const SystemServiceNode = memo(function SystemServiceNode({
  data,
}: NodeProps<SystemServiceFlowNode>) {
  const selected = useSystemStore((s) => s.selected);
  const { service, secondaryDomains } = data;
  const isSelected = selected?.kind === "service" && selected.id === service.id;

  return (
    <div
      className={`relative w-full rounded-lg border px-3 py-2 cursor-pointer transition-all ${
        isSelected
          ? "border-accent bg-accent/10"
          : "border-border-medium bg-surface hover:border-accent/60"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-1 !h-1" />
      <Handle type="source" position={Position.Right} className="!opacity-0 !w-1 !h-1" />

      <div className="font-heading text-accent text-sm font-semibold truncate">
        {service.id}
      </div>
      <div className="text-[10px] text-text-muted truncate">{service.repo}</div>
      <div className="text-[10px] text-text-secondary mt-0.5">
        {service.stats.nodes} nodes &middot; {service.stats.edges} edges
      </div>

      {secondaryDomains.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {secondaryDomains.slice(0, 3).map((d) => (
            <span
              key={d}
              className="text-[9px] px-1.5 py-0.5 rounded bg-elevated text-text-secondary"
            >
              {d}
            </span>
          ))}
          {secondaryDomains.length > 3 && (
            <span className="text-[9px] text-text-muted">
              +{secondaryDomains.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

// Registered once at module scope (NOT recreated per render).
const nodeTypes = {
  "system-domain-group": SystemDomainGroupNode,
  "system-service": SystemServiceNode,
};

// --- Pure helpers ---
function protocolColor(protocol: string): string {
  switch (protocol) {
    case "dubbo":
      return "#d4a574";
    case "http":
      return "#5b9bd5";
    case "mq":
      return "#a78bdb";
    default:
      return "#8a8a8a";
  }
}

/**
 * Choose a service's PRIMARY domain (the cluster box that contains it).
 * Candidates are the service's domains that also exist as a SystemDomain. The
 * winner is the candidate touched by the most cross-service `calls` edges tagged
 * with that domain; ties / no edge signal fall back to the first candidate in
 * localeCompare order. Returns null when the service has no candidate domains.
 */
function pickPrimaryDomain(
  service: SystemService,
  domainNames: Set<string>,
  callsEdges: SystemCallsEdge[],
): string | null {
  const sorted = service.domains
    .filter((d) => domainNames.has(d))
    .sort((a, b) => a.localeCompare(b));
  if (sorted.length === 0) return null;

  const counts = new Map<string, number>();
  for (const d of sorted) counts.set(d, 0);
  for (const edge of callsEdges) {
    if (!edge.domain || !counts.has(edge.domain)) continue;
    if (edge.sourceService === service.id || edge.targetService === service.id) {
      counts.set(edge.domain, (counts.get(edge.domain) ?? 0) + 1);
    }
  }

  let best = sorted[0];
  let bestCount = counts.get(best) ?? 0;
  for (const d of sorted) {
    const ct = counts.get(d) ?? 0;
    if (ct > bestCount) {
      best = d;
      bestCount = ct;
    }
  }
  return best;
}

function SystemGraphViewInner({
  onDrill,
}: {
  onDrill: (ref: string | null | undefined, nodeId?: string) => void;
}): JSX.Element {
  const systemGraph = useSystemStore((s) => s.systemGraph);
  const selected = useSystemStore((s) => s.selected);
  const selectService = useSystemStore((s) => s.selectService);
  const selectEdge = useSystemStore((s) => s.selectEdge);
  const clearSelection = useSystemStore((s) => s.clearSelection);

  // Build nodes. Selection styling is read from the store inside the service node
  // component, so this memo does NOT depend on `selected`.
  const nodes = useMemo<Node[]>(() => {
    if (!systemGraph) return [];

    const callsEdges = systemGraph.edges.filter(
      (e): e is SystemCallsEdge => e.type === "calls",
    );
    const domainNames = new Set(systemGraph.domains.map((d) => d.name));
    const domainByName = new Map<string, SystemDomain>();
    for (const d of systemGraph.domains) domainByName.set(d.name, d);

    // Bucket services by their primary domain name (in services order for stability).
    const membersByDomain = new Map<string, SystemService[]>();
    const ungrouped: SystemService[] = [];
    const primaryOf = new Map<string, string | null>();
    for (const service of systemGraph.services) {
      const primary = pickPrimaryDomain(service, domainNames, callsEdges);
      primaryOf.set(service.id, primary);
      if (primary === null) {
        ungrouped.push(service);
      } else {
        const list = membersByDomain.get(primary);
        if (list) list.push(service);
        else membersByDomain.set(primary, [service]);
      }
    }

    const groupNodes: Node[] = [];
    const childNodes: Node[] = [];
    let xCursor = 0;

    // One group box per domain that has >=1 member, in systemGraph.domains order.
    for (const domain of systemGraph.domains) {
      const members = membersByDomain.get(domain.name);
      if (!members || members.length === 0) continue;

      const n = members.length;
      const groupWidth = SERVICE_W + 2 * PAD;
      const groupHeight =
        HEADER + PAD + n * SERVICE_H + (n - 1) * SERVICE_GAP + PAD;

      groupNodes.push({
        id: domain.id,
        type: "system-domain-group",
        position: { x: xCursor, y: 0 },
        style: { width: groupWidth, height: groupHeight },
        selectable: false,
        draggable: false,
        data: { label: domain.name } satisfies SystemDomainGroupData,
      });

      members.forEach((service, i) => {
        const secondaryDomains = service.domains.filter((d) => d !== domain.name);
        childNodes.push({
          id: service.id,
          type: "system-service",
          parentId: domain.id,
          extent: "parent",
          position: { x: PAD, y: HEADER + PAD + i * (SERVICE_H + SERVICE_GAP) },
          style: { width: SERVICE_W },
          data: { service, secondaryDomains } satisfies SystemServiceData,
        });
      });

      xCursor += groupWidth + GROUP_GAP;
    }

    // Ungrouped services: top-level vertical column to the right of the last group.
    const ungroupedNodes: Node[] = ungrouped.map((service, i) => ({
      id: service.id,
      type: "system-service",
      position: { x: xCursor, y: i * (SERVICE_H + SERVICE_GAP) },
      style: { width: SERVICE_W },
      data: {
        service,
        // No primary domain assigned -> surface all of its domains as chips.
        secondaryDomains: service.domains,
      } satisfies SystemServiceData,
    }));

    // CRITICAL: parent (group) nodes must precede their children in the array.
    return [...groupNodes, ...childNodes, ...ungroupedNodes];
  }, [systemGraph]);

  // Build edges (calls only). Depends on `selected` for selection styling.
  const edges = useMemo<Edge[]>(() => {
    if (!systemGraph) return [];
    const serviceIds = new Set(systemGraph.services.map((s) => s.id));
    const result: Edge[] = [];

    for (const e of systemGraph.edges) {
      if (e.type !== "calls") continue;
      if (!serviceIds.has(e.sourceService) || !serviceIds.has(e.targetService)) {
        continue;
      }

      const color = protocolColor(e.protocol);
      const isSel = selected?.kind === "edge" && selected.id === e.id;
      const style: CSSProperties = {
        stroke: color,
        strokeWidth: isSel ? 2 : 1.5,
        opacity: isSel ? 1 : 0.7,
      };
      if (e.confidence < 0.7) style.strokeDasharray = "5 4";

      result.push({
        id: e.id,
        source: e.sourceService,
        target: e.targetService,
        animated: isSel,
        label: e.protocol,
        labelStyle: { fill: "var(--color-text-muted)", fontSize: 9 },
        labelShowBg: false,
        style,
        markerEnd: { type: MarkerType.ArrowClosed, color },
      });
    }
    return result;
  }, [systemGraph, selected]);

  const onNodeClick = useCallback(
    (_: ReactMouseEvent, node: Node) => {
      if (node.type === "system-service") selectService(node.id);
    },
    [selectService],
  );

  const onNodeDoubleClick = useCallback(
    (_: ReactMouseEvent, node: Node) => {
      if (node.type !== "system-service") return;
      const service = systemGraph?.services.find((s) => s.id === node.id);
      if (service) onDrill(service.graphRef);
    },
    [systemGraph, onDrill],
  );

  const onEdgeClick = useCallback(
    (_: ReactMouseEvent, edge: Edge) => {
      selectEdge(edge.id);
    },
    [selectEdge],
  );

  const onPaneClick = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  if (!systemGraph) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-root">
        <p className="text-text-muted text-sm">Loading system graph&hellip;</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.05}
        maxZoom={2}
      >
        <Background
          variant={BackgroundVariant.Dots}
          color="var(--color-edge-dot)"
          gap={20}
          size={1}
        />
        <Controls />
        <MiniMap
          nodeColor="var(--color-elevated)"
          maskColor="var(--glass-bg)"
          className="!bg-surface !border !border-border-subtle"
        />
      </ReactFlow>
    </div>
  );
}

export default function SystemGraphView({
  onDrill,
}: {
  onDrill: (ref: string | null | undefined, nodeId?: string) => void;
}): JSX.Element {
  return (
    <ReactFlowProvider>
      <SystemGraphViewInner onDrill={onDrill} />
    </ReactFlowProvider>
  );
}
