import type { JSX, ReactNode } from "react";
import type {
  SystemGraph,
  SystemService,
  SystemCallsEdge,
  SystemFlowEdge,
  SystemEdge,
  SystemUnresolved,
} from "@understand-anything/core/types";
import { useSystemStore } from "../systemStore";

// ---------------------------------------------------------------------------
// Small presentational helpers (match DomainClusterNode / NodeInfo conventions)
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="text-[9px] uppercase tracking-wider text-text-muted">{children}</div>
  );
}

function Chip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-elevated text-text-secondary">
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-lg bg-surface border border-border-subtle px-2 py-2">
      <div className="text-accent font-heading text-lg leading-none">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-text-muted mt-1">{label}</div>
    </div>
  );
}

const DRILL_BUTTON_BASE =
  "w-full mt-3 px-3 py-2 rounded-lg bg-accent/15 text-accent text-sm font-semibold";

function DrillButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${DRILL_BUTTON_BASE} ${
        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-accent/25"
      }`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// A) System Overview (nothing selected)
// ---------------------------------------------------------------------------

function UnresolvedRow({ u }: { u: SystemUnresolved }): JSX.Element {
  return (
    <div className="rounded bg-surface border border-border-subtle px-2 py-1.5">
      <div className="flex items-center gap-1 flex-wrap">
        <Chip>{u.kind}</Chip>
        <span className="text-[11px] text-text-secondary break-all">{u.key}</span>
      </div>
      <div className="text-[10px] text-text-muted mt-0.5">from {u.consumerService}</div>
      <div className="text-[10px] text-text-muted">{u.reason}</div>
    </div>
  );
}

function Overview({ graph }: { graph: SystemGraph }): JSX.Element {
  const callsCount = graph.edges.filter((e) => e.type === "calls").length;
  const flowsCount = graph.edges.filter((e) => e.type === "flow").length;
  const unresolved = graph.unresolved;

  return (
    <div className="space-y-4">
      <h3 className="font-heading text-accent text-sm">System Overview</h3>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Services" value={graph.services.length} />
        <Stat label="Domains" value={graph.domains.length} />
        <Stat label="Cross-service calls" value={callsCount} />
        <Stat label="Flows" value={flowsCount} />
      </div>

      <div>
        <SectionLabel>Domains</SectionLabel>
        <div className="space-y-1 mt-1">
          {graph.domains.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded bg-surface border border-border-subtle px-2 py-1.5"
            >
              <span className="text-[11px] text-text-secondary truncate">{d.name}</span>
              <span className="text-[10px] text-text-muted ml-2 shrink-0">
                {d.serviceIds.length} service{d.serviceIds.length !== 1 ? "s" : ""}
              </span>
            </div>
          ))}
          {graph.domains.length === 0 && (
            <p className="text-[10px] text-text-muted">None</p>
          )}
        </div>
      </div>

      {unresolved.length > 0 && (
        <div>
          <SectionLabel>Unresolved ({unresolved.length})</SectionLabel>
          <div className="space-y-1 mt-1">
            {unresolved.slice(0, 20).map((u, i) => (
              <UnresolvedRow key={`${u.consumerService}:${u.key}:${i}`} u={u} />
            ))}
            {unresolved.length > 20 && (
              <p className="text-[10px] text-text-muted">+{unresolved.length - 20} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// B) Service Info (a service selected)
// ---------------------------------------------------------------------------

function ServiceInfo({
  graph,
  service,
  onDrill,
}: {
  graph: SystemGraph;
  service: SystemService;
  onDrill: (ref: string | null | undefined, nodeId?: string) => void;
}): JSX.Element {
  const calls = graph.edges.filter((e): e is SystemCallsEdge => e.type === "calls");
  const related = [
    ...calls
      .filter((e) => e.sourceService === service.id)
      .map((edge) => ({ edge, dir: "out" as const })),
    ...calls
      .filter((e) => e.targetService === service.id)
      .map((edge) => ({ edge, dir: "in" as const })),
  ];

  return (
    <div className="space-y-3">
      <h3 className="font-heading text-accent text-sm break-all">{service.id}</h3>

      <div>
        <SectionLabel>Repo</SectionLabel>
        <div className="text-[11px] font-mono text-text-secondary break-all mt-0.5">
          {service.repo}
        </div>
      </div>

      <div className="text-[11px] text-text-muted">
        {service.stats.nodes} nodes · {service.stats.edges} edges
      </div>

      {service.domains.length > 0 && (
        <div>
          <SectionLabel>Domains</SectionLabel>
          <div className="flex flex-wrap gap-1 mt-1">
            {service.domains.map((d) => (
              <Chip key={d}>{d}</Chip>
            ))}
          </div>
        </div>
      )}

      <DrillButton label="Open service →" onClick={() => onDrill(service.graphRef)} />

      {related.length > 0 && (
        <div>
          <SectionLabel>Cross-service calls ({related.length})</SectionLabel>
          <div className="space-y-1 mt-1">
            {related.map(({ edge, dir }) => (
              <button
                key={edge.id}
                type="button"
                onClick={() => useSystemStore.getState().selectEdge(edge.id)}
                className="block w-full text-left rounded bg-surface border border-border-subtle hover:border-accent px-2 py-1.5 transition-colors"
              >
                <div className="flex items-center gap-1 flex-wrap">
                  <Chip>{edge.protocol}</Chip>
                  <span className="text-[11px] text-text-secondary">
                    {dir === "out" ? `→ ${edge.targetService}` : `← ${edge.sourceService}`}
                  </span>
                </div>
                <div className="text-[10px] text-text-muted break-all mt-0.5">{edge.key}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// C) Edge Info (a cross-service edge selected)
// ---------------------------------------------------------------------------

function CallsEdgeInfo({
  edge,
  onDrill,
}: {
  edge: SystemCallsEdge;
  onDrill: (ref: string | null | undefined, nodeId?: string) => void;
}): JSX.Element {
  const pct = Math.round(edge.confidence * 100);
  const lowConfidence = edge.confidence < 0.7;

  return (
    <div className="space-y-3">
      <h3 className="font-heading text-accent text-sm break-all">
        {edge.sourceService} → {edge.targetService}
      </h3>

      <div className="flex items-center gap-2">
        <SectionLabel>Protocol</SectionLabel>
        <Chip>{edge.protocol}</Chip>
      </div>

      <div>
        <SectionLabel>Key</SectionLabel>
        <div className="text-[11px] font-mono text-text-secondary break-all mt-0.5">
          {edge.key}
        </div>
      </div>

      <div>
        <SectionLabel>Confidence</SectionLabel>
        <div className="text-[11px] text-text-secondary mt-0.5">
          {pct}%
          {lowConfidence && <span className="text-text-muted"> (low confidence)</span>}
        </div>
      </div>

      {edge.domain && (
        <div>
          <SectionLabel>Domain</SectionLabel>
          <div className="text-[11px] text-text-secondary mt-0.5">{edge.domain}</div>
        </div>
      )}

      {edge.evidence && (
        <div>
          <SectionLabel>Evidence</SectionLabel>
          <div className="text-[10px] text-text-muted mt-0.5 whitespace-pre-wrap break-words">
            {edge.evidence}
          </div>
        </div>
      )}

      <DrillButton
        label="Open caller →"
        disabled={edge.from.graphRef === null}
        onClick={() => {
          if (!edge.from.graphRef) return;
          onDrill(edge.from.graphRef, edge.from.nodeId);
        }}
      />
      <DrillButton
        label="Open provider →"
        disabled={edge.to.graphRef === null}
        onClick={() => {
          if (!edge.to.graphRef) return;
          onDrill(edge.to.graphRef, edge.to.nodeId);
        }}
      />
    </div>
  );
}

function FlowEdgeInfo({ edge }: { edge: SystemFlowEdge }): JSX.Element {
  return (
    <div className="space-y-3">
      <h3 className="font-heading text-accent text-sm break-all">Flow · {edge.domain}</h3>

      <div>
        <SectionLabel>Sequence</SectionLabel>
        <div className="flex flex-wrap items-center gap-1 mt-1">
          {edge.sequence.map((svc, i) => (
            <span key={`${svc}-${i}`} className="flex items-center gap-1">
              <Chip>{svc}</Chip>
              {i < edge.sequence.length - 1 && (
                <span className="text-[10px] text-text-muted">→</span>
              )}
            </span>
          ))}
        </div>
      </div>

      {edge.via.length > 0 && (
        <div>
          <SectionLabel>Via</SectionLabel>
          <div className="flex flex-wrap gap-1 mt-1">
            {edge.via.map((v, i) => (
              <Chip key={`${v}-${i}`}>{v}</Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EdgeInfo({
  edge,
  onDrill,
}: {
  edge: SystemEdge;
  onDrill: (ref: string | null | undefined, nodeId?: string) => void;
}): JSX.Element {
  if (edge.type === "flow") {
    return <FlowEdgeInfo edge={edge} />;
  }
  return <CallsEdgeInfo edge={edge} onDrill={onDrill} />;
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export default function SystemSidebar({
  onDrill,
}: {
  onDrill: (ref: string | null | undefined, nodeId?: string) => void;
}): JSX.Element {
  const systemGraph = useSystemStore((s) => s.systemGraph);
  const selected = useSystemStore((s) => s.selected);

  const shell = (body: ReactNode): JSX.Element => (
    <div className="h-full overflow-auto p-4 text-text-primary">{body}</div>
  );

  if (!systemGraph) {
    return shell(<p className="text-xs text-text-muted">No system graph loaded.</p>);
  }

  if (selected?.kind === "service") {
    const service = systemGraph.services.find((s) => s.id === selected.id);
    if (service) {
      return shell(
        <ServiceInfo graph={systemGraph} service={service} onDrill={onDrill} />
      );
    }
  } else if (selected?.kind === "edge") {
    const edge = systemGraph.edges.find((e) => e.id === selected.id);
    if (edge) {
      return shell(<EdgeInfo edge={edge} onDrill={onDrill} />);
    }
  }

  return shell(<Overview graph={systemGraph} />);
}
