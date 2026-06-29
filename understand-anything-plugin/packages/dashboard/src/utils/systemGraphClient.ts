// Fetch + validate the federated system-graph.json for the system (split) dashboard.
import { validateSystemGraph } from "@understand-anything/core/schema";
import type { SystemGraph } from "@understand-anything/core/types";

export function systemGraphUrl(token: string | null): string {
  return token ? `/system-graph.json?token=${encodeURIComponent(token)}` : "/system-graph.json";
}

export type SystemGraphResult =
  | { ok: true; graph: SystemGraph }
  | { ok: false; error: string };

export async function fetchAndValidateSystemGraph(token: string | null): Promise<SystemGraphResult> {
  let res: Response;
  try {
    res = await fetch(systemGraphUrl(token));
  } catch (e) {
    return { ok: false, error: `Failed to fetch system graph: ${(e as Error).message}` };
  }
  if (!res.ok) {
    return { ok: false, error: `System graph request failed (${res.status})` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "System graph response was not valid JSON" };
  }
  const v = validateSystemGraph(data);
  if (!v.success || !v.data) {
    return { ok: false, error: v.fatal ?? "System graph failed validation" };
  }
  return { ok: true, graph: v.data };
}
