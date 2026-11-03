/**
 * Check the policies installed in a user's Turnkey sub-organization against what one Tax Alpha position
 * should have installed: its ALLOW and its DENY, byte for byte (effect, consensus, condition), and no other
 * policy granting anything to the position's signer.
 *
 * The ALLOW is checked against the CURRENT generation (s2). An ALLOW that is byte for byte the SUPERSEDED
 * generation (s1) is a warning, not a mismatch: it is exactly what Darwin installed before 2026-11-03, but it
 * lacks the relay-close bound, and the user should run the in-app "Security update".
 */
import { acceptedAllowPolicyNames, expectedPositionPolicies, supersededAllowPolicy, type ExpectedPolicy, type PositionParams } from "../permissions/position";
import type { InstalledPolicy } from "./export";

export type CheckStatus = "pass" | "fail" | "warn" | "info";
export interface Check { id: string; status: CheckStatus; message: string; detail?: string }
export interface VerifyResult {
  /** No check failed. (A superseded ALLOW is a warning, so `ok` can be true with `superseded` true.) */
  ok: boolean;
  /** A superseded (s1) ALLOW for this position is installed, alone or beside the current one. */
  superseded: boolean;
  /** The ALLOW generation found: "s2" (current), "s1" (superseded only), or null (none matched). */
  generation: "s2" | "s1" | null;
  checks: Check[];
}

export const SUPERSEDED_MESSAGE = "s1: superseded, missing the relay-close bound; run the Security update in Darwin";

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

const same = (p: InstalledPolicy, w: ExpectedPolicy) => p.effect === w.effect && p.consensus === w.consensus && p.condition === w.condition;

function checkOne(kind: "ALLOW" | "DENY", want: ExpectedPolicy, installed: InstalledPolicy[], userId: string, opts: { names?: string[]; alsoAccepted?: ExpectedPolicy[] } = {}): { checks: Check[]; matched: InstalledPolicy | null; reported: InstalledPolicy[] } {
  const checks: Check[] = [];
  const exact = installed.filter((p) => same(p, want));
  if (exact.length >= 1) {
    const m = exact[0]!;
    checks.push({ id: `${kind.toLowerCase()}_matches`, status: "pass", message: `${kind} policy ${label(m)} matches the expected text byte for byte (effect, consensus, condition)` });
    if (exact.length > 1) checks.push({ id: `${kind.toLowerCase()}_duplicate`, status: "info", message: `${exact.length} identical ${kind} policies are installed; duplicates grant nothing extra` });
    const names = opts.names?.length ? opts.names : want.policyName ? [want.policyName] : [];
    if (names.length && !names.includes(m.policyName ?? "")) {
      checks.push({ id: `${kind.toLowerCase()}_name`, status: "info", message: `${kind} policy name is ${label(m)}, expected ${names.map((n) => `'${n}'`).join(" or ")} (names are informational; the condition is what Turnkey enforces)` });
    }
    return { checks, matched: m, reported: [] };
  }
  // No exact match: explain the closest candidate (same effect, names this user).
  const accepted = opts.alsoAccepted ?? [];
  const near = installed.filter((p) => p.effect === want.effect && !accepted.some((a) => same(p, a)) && (p.consensus === want.consensus || p.consensus.includes(userId)));
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
  const s1 = supersededAllowPolicy(params);
  const userId = params.strategyUserId;
  const s1Installed = installed.filter((p) => same(p, s1));
  const s2Installed = installed.filter((p) => same(p, expected.allow));
  const checks: Check[] = [];
  let reported: InstalledPolicy[] = [];

  if (s2Installed.length === 0 && s1Installed.length > 0) {
    // Exactly what Darwin installed before the relay-close bound: a warning, never a mismatch.
    checks.push({ id: "allow_superseded", status: "warn", message: `ALLOW policy ${label(s1Installed[0]!)} — ${SUPERSEDED_MESSAGE}`, detail: "It matches the superseded generation (s1) byte for byte. s1 let the position's key close the position's wrapped-SOL account to Darwin's relay wallet; s2 does not." });
  } else {
    const allow = checkOne("ALLOW", expected.allow, installed, userId, { names: acceptedAllowPolicyNames(params), alsoAccepted: [s1] });
    checks.push(...allow.checks);
    reported = allow.reported;
    if (s2Installed.length > 0 && s1Installed.length > 0) {
      // Turnkey ALLOWs add up: while the s1 one is installed, the key can still do everything s1 allows.
      checks.push({ id: "allow_superseded", status: "warn", message: `the superseded ALLOW ${label(s1Installed[0]!)} is still installed beside the current one — ${SUPERSEDED_MESSAGE}` });
    }
  }
  const deny = checkOne("DENY", expected.deny, installed, userId);
  checks.push(...deny.checks);

  // Turnkey ALLOW policies are OR'd: any OTHER policy that names the position's signer could widen what it may do.
  const isExpected = (p: InstalledPolicy) => same(p, expected.allow) || same(p, s1) || same(p, expected.deny);
  const reportedSet = new Set([...reported, ...deny.reported]);
  const others = installed.filter((p) => !isExpected(p) && !reportedSet.has(p) && (p.consensus.includes(userId) || p.condition.includes(userId)));
  const otherAllows = others.filter((p) => p.effect === "EFFECT_ALLOW");
  const otherDenies = others.filter((p) => p.effect !== "EFFECT_ALLOW");
  if (otherAllows.length === 0) {
    checks.push({ id: "no_other_grants", status: "pass", message: "no other ALLOW policy names this position's signer" });
  } else {
    for (const p of otherAllows) checks.push({ id: "no_other_grants", status: "fail", message: `another ALLOW policy ${label(p)} names this position's signer — it could let the key do more than the published template`, detail: `consensus: ${p.consensus}\ncondition: ${p.condition.slice(0, 400)}` });
  }
  for (const p of otherDenies) checks.push({ id: "other_deny", status: "info", message: `an additional DENY policy ${label(p)} names this position's signer (a DENY can only restrict)` });

  // An ALLOW whose approvers are not pinned to specific user ids might also cover the position's signer.
  const broad = installed.filter((p) => p.effect === "EFFECT_ALLOW" && !isExpected(p) && !reportedSet.has(p) && !p.consensus.includes(userId) && !/user\.id\s*==\s*'[^']+'/.test(p.consensus));
  for (const p of broad) {
    checks.push({ id: "broad_allow", status: "warn", message: `ALLOW policy ${label(p)} does not pin its approvers to specific user ids; review whether it could apply to this position's signer`, detail: `consensus: ${p.consensus || "(empty)"}` });
  }
  const ok = checks.every((c) => c.status !== "fail");
  return { ok, superseded: s1Installed.length > 0, generation: s2Installed.length > 0 ? "s2" : s1Installed.length > 0 ? "s1" : null, checks };
}

export function formatResult(r: VerifyResult): string {
  const tag: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" };
  const lines = r.checks.map((c) => `${tag[c.status]}  ${c.message}${c.detail ? `\n${c.detail.split("\n").map((l) => `        ${l}`).join("\n")}` : ""}`);
  lines.push("", !r.ok
    ? "RESULT: FAIL — the installed permissions differ from the published templates (see FAIL lines above)."
    : r.superseded
      ? `RESULT: WARNING — ${SUPERSEDED_MESSAGE}. Nothing else differs from the published templates.`
      : "RESULT: PASS — the installed permissions for this position are exactly the published templates.");
  return lines.join("\n");
}
