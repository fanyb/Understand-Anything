// Lazy-load + validate one service's knowledge-graph.json for multi-repo drill-down.
// Kept out of the store so the fetch/validate logic is unit-testable in isolation.
import { validateGraph } from "@understand-anything/core/schema";
import type { KnowledgeGraph } from "@understand-anything/core/types";

/** Build the token-gated, ref-addressed service-graph URL. */
export function serviceGraphUrl(ref: string, token: string | null): string {
  const params = new URLSearchParams({ ref });
  if (token) params.set("token", token);
  return `/service-graph.json?${params.toString()}`;
}

export type ServiceGraphResult =
  | { ok: true; graph: KnowledgeGraph }
  | { ok: false; error: string };

/** Fetch a service graph by ref and run it through core's validator. */
export async function fetchAndValidateServiceGraph(
  ref: string,
  token: string | null,
): Promise<ServiceGraphResult> {
  let res: Response;
  try {
    res = await fetch(serviceGraphUrl(ref, token));
  } catch (e) {
    return { ok: false, error: `Failed to fetch service graph: ${(e as Error).message}` };
  }
  if (!res.ok) {
    return { ok: false, error: `Service graph request failed (${res.status})` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Service graph response was not valid JSON" };
  }
  const validation = validateGraph(data);
  if (!validation.success || !validation.data) {
    return { ok: false, error: validation.fatal ?? "Service graph failed validation" };
  }
  return { ok: true, graph: validation.data as KnowledgeGraph };
}
