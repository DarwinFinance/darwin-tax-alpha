/**
 * Reading a Turnkey policy export.
 *
 * Accepted shapes (all straight from Turnkey, no Darwin server in between):
 *   - the response body of Turnkey's `POST /public/v1/query/list_policies` for your sub-organization:
 *       { "policies": [ { "policyId", "policyName", "effect", "consensus", "condition", "notes", ... } ] }
 *   - the same `policies` array on its own.
 */
export interface InstalledPolicy {
  policyId?: string;
  policyName?: string;
  effect: string;
  consensus: string;
  condition: string;
  notes?: string;
}

export function parsePolicyExport(json: unknown): InstalledPolicy[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { policies?: unknown }).policies)
      ? (json as { policies: unknown[] }).policies
      : null;
  if (!list) throw new Error("not a Turnkey policy export: expected { \"policies\": [...] } or an array of policies");
  return list.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`policies[${i}] is not an object`);
    const o = p as Record<string, unknown>;
    if (typeof o.effect !== "string") throw new Error(`policies[${i}].effect is missing`);
    // Turnkey omits an empty consensus/condition; treat absent as "" so it can never equal a real expectation.
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      policyId: typeof o.policyId === "string" ? o.policyId : undefined,
      policyName: typeof o.policyName === "string" ? o.policyName : undefined,
      effect: o.effect,
      consensus: str(o.consensus),
      condition: str(o.condition),
      notes: typeof o.notes === "string" ? o.notes : undefined,
    };
  });
}
