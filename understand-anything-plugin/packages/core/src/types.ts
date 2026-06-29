// Node types (21 total: 5 code + 8 non-code + 3 domain + 5 knowledge)
export type NodeType =
  | "file" | "function" | "class" | "module" | "concept"
  | "config" | "document" | "service" | "table" | "endpoint"
  | "pipeline" | "schema" | "resource"
  | "domain" | "flow" | "step"
  | "article" | "entity" | "topic" | "claim" | "source";

// Edge types (35 total in 8 categories: Structural, Behavioral, Data flow, Dependencies, Semantic, Infrastructure/Schema, Domain, Knowledge)
export type EdgeType =
  | "imports" | "exports" | "contains" | "inherits" | "implements"  // Structural
  | "calls" | "subscribes" | "publishes" | "middleware"              // Behavioral
  | "reads_from" | "writes_to" | "transforms" | "validates"         // Data flow
  | "depends_on" | "tested_by" | "configures"                       // Dependencies
  | "related" | "similar_to"                                         // Semantic
  | "deploys" | "serves" | "provisions" | "triggers"                // Infrastructure
  | "migrates" | "documents" | "routes" | "defines_schema"          // Schema/Data
  | "contains_flow" | "flow_step" | "cross_domain"                  // Domain
  | "cites" | "contradicts" | "builds_on" | "exemplifies" | "categorized_under" | "authored_by"; // Knowledge

// Optional knowledge metadata for article/entity/topic/claim/source nodes
export interface KnowledgeMeta {
  wikilinks?: string[];
  backlinks?: string[];
  category?: string;
  content?: string;
}

// Optional domain metadata for domain/flow/step nodes
export interface DomainMeta {
  entities?: string[];
  businessRules?: string[];
  crossDomainInteractions?: string[];
  entryPoint?: string;
  entryType?: "http" | "cli" | "event" | "cron" | "manual";
}

// GraphNode with 21 types: 5 code + 8 non-code + 3 domain + 5 knowledge
export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  filePath?: string;
  lineRange?: [number, number];
  summary: string;
  tags: string[];
  complexity: "simple" | "moderate" | "complex";
  languageNotes?: string;
  domainMeta?: DomainMeta;
  knowledgeMeta?: KnowledgeMeta;
}

// GraphEdge with rich relationship modeling
export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  direction: "forward" | "backward" | "bidirectional";
  description?: string;
  weight: number; // 0-1
}

// Layer (logical grouping)
export interface Layer {
  id: string;
  name: string;
  description: string;
  nodeIds: string[];
}

// TourStep (for learn mode)
export interface TourStep {
  order: number;
  title: string;
  description: string;
  nodeIds: string[];
  languageLesson?: string;
}

// ProjectMeta
export interface ProjectMeta {
  name: string;
  languages: string[];
  frameworks: string[];
  description: string;
  analyzedAt: string;
  gitCommitHash: string;
}

// Root KnowledgeGraph
export interface KnowledgeGraph {
  version: string;
  kind?: "codebase" | "knowledge";
  project: ProjectMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: Layer[];
  tour: TourStep[];
}

// === System graph (multi-repo federation, produced by /understand-link) ===
// The federated Tier-0 graph: services + business domains as nodes, cross-service
// calls + per-domain flow as edges. It is reference-based — each service points to
// its own knowledge-graph.json via graphRef (relative to the workspace root, may
// contain "../"); the dashboard lazy-loads those for drill-down.

/** A drill-down anchor into a service's own graph. graphRef can be null when the service has no graph. */
export interface SystemGraphRef {
  graphRef: string | null;
  nodeId: string;
}

export interface SystemService {
  id: string;
  repo: string;
  domains: string[];
  graphRef: string;
  stats: { nodes: number; edges: number };
}

export interface SystemDomain {
  id: string; // "domain:<name>"
  name: string;
  serviceIds: string[];
}

/** Cross-service call edge. `protocol` is the consumer kind (dubbo/http/mq today). */
export interface SystemCallsEdge {
  id: string;
  type: "calls";
  protocol: string;
  domain?: string; // from the provider side; may be absent
  sourceService: string;
  targetService: string;
  key: string;
  from: SystemGraphRef;
  to: SystemGraphRef;
  confidence: number;
  evidence: string;
}

/** Per-domain flow skeleton: the ordered sequence of services touched, plus protocols. */
export interface SystemFlowEdge {
  id: string;
  type: "flow";
  domain: string;
  sequence: string[];
  via: string[];
}

export type SystemEdge = SystemCallsEdge | SystemFlowEdge;

/** A consumer whose provider was not found in the registry (carried through for reporting). */
export interface SystemUnresolved {
  kind: string;
  key: string;
  consumerService: string;
  nodeId: string;
  reason: string;
}

export interface SystemGraph {
  version: string;
  kind: "system";
  services: SystemService[];
  domains: SystemDomain[];
  edges: SystemEdge[];
  unresolved: SystemUnresolved[];
}

// Theme configuration (for dashboard customization)
export interface ThemeConfig {
  presetId: string;
  accentId: string;
}

// AnalysisMeta (for persistence)
export interface AnalysisMeta {
  lastAnalyzedAt: string;
  gitCommitHash: string;
  version: string;
  analyzedFiles: number;
  theme?: ThemeConfig;
}

// Project config (for auto-update opt-in and language preference)
export interface ProjectConfig {
  autoUpdate: boolean;
  outputLanguage?: string;
}

// Non-code structural sub-interfaces
export interface SectionInfo {
  name: string;
  level: number;
  lineRange: [number, number];
}

export interface DefinitionInfo {
  name: string;
  /** Parser-reported definition kind. Known values: "table", "view", "index", "message", "enum", "type", "input", "interface", "union", "scalar", "variable", "output", "resource", "data", "section", "target", "stage" */
  kind: string;
  lineRange: [number, number];
  fields: string[];
}

export interface ServiceInfo {
  name: string;
  image?: string;
  ports: number[];
  lineRange?: [number, number];
}

export interface EndpointInfo {
  method?: string;
  path: string;
  lineRange: [number, number];
}

export interface StepInfo {
  name: string;
  lineRange: [number, number];
}

export interface ResourceInfo {
  name: string;
  kind: string;
  lineRange: [number, number];
}

export interface ReferenceResolution {
  source: string;
  target: string;
  referenceType: string; // "file", "image", "schema", "service"
  line?: number;
}

// Plugin interfaces
export interface StructuralAnalysis {
  functions: Array<{ name: string; lineRange: [number, number]; params: string[]; returnType?: string }>;
  classes: Array<{ name: string; lineRange: [number, number]; methods: string[]; properties: string[] }>;
  imports: Array<{ source: string; specifiers: string[]; lineNumber: number }>;
  exports: Array<{ name: string; lineNumber: number; isDefault?: boolean }>;
  // Non-code structural data (all optional for backward compat)
  sections?: SectionInfo[];
  definitions?: DefinitionInfo[];
  services?: ServiceInfo[];
  endpoints?: EndpointInfo[];
  steps?: StepInfo[];
  resources?: ResourceInfo[];
}

export interface ImportResolution {
  source: string;
  resolvedPath: string;
  specifiers: string[];
}

export interface CallGraphEntry {
  caller: string;
  callee: string;
  lineNumber: number;
}

export interface AnalyzerPlugin {
  name: string;
  languages: string[];
  analyzeFile(filePath: string, content: string): StructuralAnalysis;
  resolveImports?(filePath: string, content: string): ImportResolution[];
  extractCallGraph?(filePath: string, content: string): CallGraphEntry[];
  extractReferences?(filePath: string, content: string): ReferenceResolution[];
}
