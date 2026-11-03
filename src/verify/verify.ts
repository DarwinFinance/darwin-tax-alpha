/**
 * Check the policies installed in a user's Turnkey sub-organization against what one Tax Alpha position
 * should have installed: its ALLOW and its DENY, byte for byte (effect, consensus, condition), and no other
 * policy granting anything to the position's signer.
 */
import { expectedPositionPolicies, type ExpectedPolicy, type PositionParams } from "../permissions/position";
import type { InstalledPolicy } from "./export";

export type CheckStatus = "pass" | "fail" | "warn" | "info";
export interface Check { id: string; status: CheckStatus; message: string; detail?: string }
export interface VerifyResult { ok: boolean; checks: Check[] }

/** Where two strings first differ, with a little context from each — for a readable mismatch report. */
export function firstDifference(expected: string, actual: string): string {
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  if (i === expected.length && i === actual.length) return "identical";
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 60));
  return `first difference at character ${i} (expected length ${expected.length}, installed length ${actual.length})\n` +
    `  expected:  …${ctx(expected)}…\n  installed: …${ctx(actual)}…`;
}

const label = (p: InstalledPolicy) => (p.policyName ? `'${p.policyName}'` : p.policyId ? `id ${p.policyId}` : "(unnamed)");

function checkOne(kind: "ALLOW" | "DENY", want: ExpectedPolicy, installed: InstalledPolicy[], userId: string): { checks: Check[]; matched: InstalledPolicy | null; reported: InstalledPolicy[] } {
  const checks: Check[] = [];
  const exact = installed.filter((p) => p.effect === want.effect && p.consensus === want.consensus && p.condition === want.condition);
  if (exact.length >= 1) {
    const m = exact[0]!;
    checks.push({ id: `${kind.toLowerCase()}_matches`, status: "pass", message: `${kind} policy ${label(m)} matches the expected text byte for byte (effect, consensus, condition)` });
    if (exact.length > 1) checks.push({ id: `${kind.toLowerCase()}_duplicate`, status: "info", message: `${exact.length} identical ${kind} policies are installed; duplicates grant nothing extra` });
    if (want.policyName && m.policyName !== want.policyName) {
      checks.push({ id: `${kind.toLowerCase()}_name`, status: "info", message: `${kind} policy name is ${label(m)}, expected '${want.policyName}' (names are informational; the condition is what Turnkey enforces)` });
    }
    return { checks, matched: m, reported: [] };
  }
  // No exact match: explain the closest candidate (same effect, names this user).
  const near = installed.filter((p) => p.effect === want.effect && (p.consensus === want.consensus || p.consensus.includes(userId)));
  if (near.length === 0) {
    checks.push({ id: `${kind.toLowerCase()}_matches`, status: "fail", message: `no ${kind} policy for this position's signer is installed` });
  } else {
    for (const p of near) {
      const parts: string[] = [];
      if (p.consensus !== want.consensus) parts.push(`consensus: ${firstDifference(want.consensus, p.consensus)}`);
      if (p.condition !== want.condition) parts.push(`condition: ${firstDifference(want.condition, p.condition)}`);
      checks.push({ id: `${kind.toLowerCase()}_matches`, status: "fail", message: `${kind} policy ${label(p)} does NOT match the expected text`, detail: parts.join("\n") });
    }
  }
  return { checks, matched: null, reported: near };
}

export function verifyPosition(params: PositionParams, installed: InstalledPolicy[]): VerifyResult {
  const expected = expectedPositionPolicies(params);
  const userId = params.strategyUserId;
  const allow = checkOne("ALLOW", expected.allow, installed, userId);
  const deny = checkOne("DENY", expected.deny, installed, userId);
  const checks = [...allow.checks, ...deny.checks];

  // Turnkey ALLOW policies are OR'd: any OTHER policy that names the position's signer could widen what it may do.
  const isExpected = (p: InstalledPolicy) =>
    (p.effect === expected.allow.effect && p.consensus === expected.allow.consensus && p.condition === expected.allow.condition) ||
    (p.effect === expected.deny.effect && p.consensus === expected.deny.consensus && p.condition === expected.deny.condition);
  const reported = new Set([...allow.reported, ...deny.reported]);
  const others = installed.filter((p) => !isExpected(p) && !reported.has(p) && (p.consensus.includes(userId) || p.condition.includes(userId)));
  const otherAllows = others.filter((p) => p.effect === "EFFECT_ALLOW");
  const otherDenies = others.filter((p) => p.effect !== "EFFECT_ALLOW");
  if (otherAllows.length === 0) {
    checks.push({ id: "no_other_grants", status: "pass", message: "no other ALLOW policy names this position's signer" });
  } else {
    for (const p of otherAllows) checks.push({ id: "no_other_grants", status: "fail", message: `another ALLOW policy ${label(p)} names this position's signer — it could let the key do more than the published template`, detail: `consensus: ${p.consensus}\ncondition: ${p.condition.slice(0, 400)}` });
  }
  for (const p of otherDenies) checks.push({ id: "other_deny", status: "info", message: `an additional DENY policy ${label(p)} names this position's signer (a DENY can only restrict)` });

  // An ALLOW whose approvers are not pinned to specific user ids might also cover the position's signer.
  const broad = installed.filter((p) => p.effect === "EFFECT_ALLOW" && !isExpected(p) && !reported.has(p) && !p.consensus.includes(userId) && !/user\.id\s*==\s*'[^']+'/.test(p.consensus));
  for (const p of broad) {
    checks.push({ id: "broad_allow", status: "warn", message: `ALLOW policy ${label(p)} does not pin its approvers to specific user ids; review whether it could apply to this position's signer`, detail: `consensus: ${p.consensus || "(empty)"}` });
  }
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

export function formatResult(r: VerifyResult): string {
  const tag: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" };
  const lines = r.checks.map((c) => `${tag[c.status]}  ${c.message}${c.detail ? `\n${c.detail.split("\n").map((l) => `        ${l}`).join("\n")}` : ""}`);
  lines.push("", r.ok
    ? "RESULT: PASS — the installed permissions for this position are exactly the published templates."
    : "RESULT: FAIL — the installed permissions differ from the published templates (see FAIL lines above).");
  return lines.join("\n");
}
