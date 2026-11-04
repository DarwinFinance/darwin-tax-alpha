/**
 * Check the policies installed in a user's Turnkey sub-organization against what one Tax Alpha position
 * should have installed: its ALLOW and its DENY, byte for byte (effect, consensus, condition), and no other
 * policy granting anything to the position's signer.
 *
 * The ALLOW is checked against the CURRENT generation (s3). An ALLOW that is byte for byte a SUPERSEDED
 * generation (s1 or s2) is a warning, not a mismatch: it is exactly what Darwin installed earlier, but it lacks
 * bounds the current generation has, and the user should run the in-app "Security update".
 */
import {
  acceptedAllowPolicyNames, expectedPositionPolicies, supersededAllowPolicy, SUPERSEDED_GENERATIONS,
  type ExpectedPolicy, type PositionParams, type SupersededGeneration,
} from "../permissions/position";
import type { InstalledPolicy } from "./export";

export type CheckStatus = "pass" | "fail" | "warn" | "info";
export interface Check { id: string; status: CheckStatus; message: string; detail?: string }
export interface VerifyResult {
  /** No check failed. (A superseded ALLOW is a warning, so `ok` can be true with `superseded` true.) */
  ok: boolean;
  /** A superseded (s1 or s2) ALLOW for this position is installed, alone or beside the current one. */
  superseded: boolean;
  /** Which superseded generations are installed, oldest first. */
  supersededGenerations: ShortGeneration[];
  /** The newest ALLOW generation found: "s3" (current), "s2" / "s1" (superseded only), or null (none matched). */
  generation: "s3" | ShortGeneration | null;
  checks: Check[];
}

type ShortGeneration = "s1" | "s2";
const SHORT: Record<SupersededGeneration, ShortGeneration> = { "s1-agent-v9-swap": "s1", "s2-relay-close-bound": "s2" };

/** The warning for each superseded generation, naming what it is missing. */
export const SUPERSEDED_MESSAGES: Readonly<Record<ShortGeneration, string>> = {
  s1: "s1: superseded, missing the relay-close bound and the dFlow wrap_sol/ATA-owner bounds; run the Security update in Darwin",
  s2: "s2: superseded, missing the dFlow wrap_sol/ATA-owner bounds; run the Security update in Darwin",
};
const SUPERSEDED_DETAIL: Readonly<Record<ShortGeneration, string>> = {
  s1: "It matches the superseded generation s1 byte for byte. s1 let the position's key close the position's wrapped-SOL account to Darwin's relay wallet, and (like s2) did not bind who owns a token account created inside a dFlow swap or where a dFlow wrap_sol deposits; s3 binds all three.",
  s2: "It matches the superseded generation s2 byte for byte. s2 did not bind who owns a token account created inside a dFlow swap (the position's wallet could pay rent for an account another address owns) or where a dFlow wrap_sol deposits (it could wrap the position's SOL into another address's existing wSOL account); s3 binds both to the position's own accounts.",
};

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
  const superseded = SUPERSEDED_GENERATIONS.map((g) => ({ g: SHORT[g], policy: supersededAllowPolicy(params, g) }));
  const userId = params.strategyUserId;
  const currentInstalled = installed.filter((p) => same(p, expected.allow));
  const supersededInstalled = superseded
    .map(({ g, policy }) => ({ g, policy, found: installed.filter((p) => same(p, policy)) }))
    .filter((x) => x.found.length > 0);
  const checks: Check[] = [];
  let reported: InstalledPolicy[] = [];

  if (currentInstalled.length === 0 && supersededInstalled.length > 0) {
    // Exactly what Darwin installed before a newer generation: a warning per generation, never a mismatch.
    for (const { g, found } of supersededInstalled) {
      checks.push({ id: "allow_superseded", status: "warn", message: `ALLOW policy ${label(found[0]!)} — ${SUPERSEDED_MESSAGES[g]}`, detail: SUPERSEDED_DETAIL[g] });
    }
  } else {
    const allow = checkOne("ALLOW", expected.allow, installed, userId, { names: acceptedAllowPolicyNames(params), alsoAccepted: superseded.map((x) => x.policy) });
    checks.push(...allow.checks);
    reported = allow.reported;
    if (currentInstalled.length > 0) {
      // Turnkey ALLOWs add up: while an older one is installed, the key can still do everything it allows.
      for (const { g, found } of supersededInstalled) {
        checks.push({ id: "allow_superseded", status: "warn", message: `the superseded ALLOW ${label(found[0]!)} is still installed beside the current one — ${SUPERSEDED_MESSAGES[g]}`, detail: SUPERSEDED_DETAIL[g] });
      }
    }
  }
  const deny = checkOne("DENY", expected.deny, installed, userId);
  checks.push(...deny.checks);

  // Turnkey ALLOW policies are OR'd: any OTHER policy that names the position's signer could widen what it may do.
  const isExpected = (p: InstalledPolicy) => same(p, expected.allow) || superseded.some((x) => same(p, x.policy)) || same(p, expected.deny);
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
  const supersededGenerations = supersededInstalled.map((x) => x.g);
  const generation = currentInstalled.length > 0 ? "s3" : supersededGenerations.length > 0 ? supersededGenerations[supersededGenerations.length - 1]! : null;
  return { ok, superseded: supersededGenerations.length > 0, supersededGenerations, generation, checks };
}

export function formatResult(r: VerifyResult): string {
  const tag: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" };
  const lines = r.checks.map((c) => `${tag[c.status]}  ${c.message}${c.detail ? `\n${c.detail.split("\n").map((l) => `        ${l}`).join("\n")}` : ""}`);
  lines.push("", !r.ok
    ? "RESULT: FAIL — the installed permissions differ from the published templates (see FAIL lines above)."
    : r.superseded
      ? `RESULT: WARNING — ${r.supersededGenerations.map((g) => SUPERSEDED_MESSAGES[g]).join("; ")}. Nothing else differs from the published templates.`
      : "RESULT: PASS — the installed permissions for this position are exactly the published templates.");
  return lines.join("\n");
}
