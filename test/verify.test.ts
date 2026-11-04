import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstDifference, formatResult, parsePolicyExport, SUPERSEDED_MESSAGES, verifyPosition, type InstalledPolicy } from "../src/verify";
import { supersededAllowPolicy } from "../src/permissions";

const V = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "vectors", name), "utf8"));
const params = V("position-a.params.json");
const expected = V("position-a.expected.json");
const base = (): InstalledPolicy[] => parsePolicyExport(V("position-a.export.json"));
const failed = (r: ReturnType<typeof verifyPosition>) => r.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("verifyPosition", () => {
  it("passes the clean example export", () => {
    const r = verifyPosition(params, base());
    expect(r.ok).toBe(true);
    expect(r.superseded).toBe(false);
    expect(r.generation).toBe("s3");
    expect(failed(r)).toEqual([]);
  });

  it("position-c (set up before 2026-11-03, s1 installed): a superseded WARNING, not a mismatch", () => {
    const r = verifyPosition(V("position-c.params.json"), parsePolicyExport(V("position-c.export.json")));
    expect(r.ok).toBe(true);
    expect(r.superseded).toBe(true);
    expect(r.generation).toBe("s1");
    expect(r.supersededGenerations).toEqual(["s1"]);
    expect(failed(r)).toEqual([]);
    const w = r.checks.find((c) => c.id === "allow_superseded")!;
    expect(w.status).toBe("warn");
    expect(w.message).toContain(SUPERSEDED_MESSAGES.s1);
    expect(formatResult(r)).toContain(`RESULT: WARNING — ${SUPERSEDED_MESSAGES.s1}`);
  });

  it("position-d (set up on 2026-11-03 before s3, s2 installed): a superseded WARNING naming the dFlow bounds", () => {
    const r = verifyPosition(V("position-d.params.json"), parsePolicyExport(V("position-d.export.json")));
    expect(r.ok).toBe(true);
    expect(r.superseded).toBe(true);
    expect(r.generation).toBe("s2");
    expect(r.supersededGenerations).toEqual(["s2"]);
    expect(failed(r)).toEqual([]);
    const w = r.checks.filter((c) => c.id === "allow_superseded");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("s2: superseded, missing the dFlow wrap_sol/ATA-owner bounds; run the Security update in Darwin");
    expect(formatResult(r)).toContain(`RESULT: WARNING — ${SUPERSEDED_MESSAGES.s2}`);
  });

  it("s1 AND s2 both installed, no s3 (an s1 → s2 update left half-way): one warning per generation", () => {
    const pd = V("position-d.params.json");
    const s1: InstalledPolicy = { policyName: "tax-alpha-allow-enr_vectorD01", effect: "EFFECT_ALLOW", consensus: supersededAllowPolicy(pd, "s1-agent-v9-swap").consensus, condition: supersededAllowPolicy(pd, "s1-agent-v9-swap").condition };
    const pol = parsePolicyExport(V("position-d.export.json")).map((p) => (p.condition === supersededAllowPolicy(pd, "s2-relay-close-bound").condition ? { ...p, policyName: "tax-alpha-allow-enr_vectorD01-s2" } : p));
    const r = verifyPosition(pd, [...pol, s1]);
    expect(r.ok).toBe(true);
    expect(r.supersededGenerations).toEqual(["s1", "s2"]);
    expect(r.generation).toBe("s2");
    expect(r.checks.filter((c) => c.id === "allow_superseded").map((c) => c.status)).toEqual(["warn", "warn"]);
    expect(formatResult(r)).toContain(`RESULT: WARNING — ${SUPERSEDED_MESSAGES.s1}; ${SUPERSEDED_MESSAGES.s2}`);
  });

  it("a tampered s2 ALLOW is a mismatch, not a superseded warning", () => {
    const pd = V("position-d.params.json");
    const s2 = supersededAllowPolicy(pd, "s2-relay-close-bound").condition;
    const pol = parsePolicyExport(V("position-d.export.json")).map((p) => (p.condition === s2 ? { ...p, condition: s2.replace(" && ", "  && ") } : p));
    const r = verifyPosition(pd, pol);
    expect(r.ok).toBe(false);
    expect(r.superseded).toBe(false);
    expect(failed(r)).toEqual(["allow_matches"]);
  });

  it("a tampered s1 ALLOW is a mismatch, not a superseded warning", () => {
    const pc = V("position-c.params.json");
    const s1 = supersededAllowPolicy(pc, "s1-agent-v9-swap").condition;
    const pol = parsePolicyExport(V("position-c.export.json")).map((p) => (p.condition === s1 ? { ...p, condition: s1.replace(" && ", "  && ") } : p));
    const r = verifyPosition(pc, pol);
    expect(r.ok).toBe(false);
    expect(r.superseded).toBe(false);
    expect(failed(r)).toEqual(["allow_matches"]);
  });

  it("half-finished security update (s3 and s1 both installed): passes the s3 check but warns that s1 still widens it", () => {
    const s1: InstalledPolicy = { policyName: "tax-alpha-allow-enr_vectorA01", effect: "EFFECT_ALLOW", consensus: expected.allow.consensus, condition: supersededAllowPolicy(params, "s1-agent-v9-swap").condition };
    const pol = base().map((p) => (p.condition === expected.allow.condition ? { ...p, policyName: "tax-alpha-allow-enr_vectorA01-s3" } : p));
    const r = verifyPosition(params, [...pol, s1]);
    expect(r.ok).toBe(true);
    expect(r.superseded).toBe(true);
    expect(r.generation).toBe("s3");
    expect(r.supersededGenerations).toEqual(["s1"]);
    expect(r.checks.some((c) => c.id === "allow_superseded" && c.status === "warn" && c.message.includes(SUPERSEDED_MESSAGES.s1))).toBe(true);
    expect(r.checks.some((c) => c.id === "allow_name")).toBe(false); // the -s3 name is accepted
  });

  it("half-finished security update (s3 and s2 both installed): passes the s3 check but warns that s2 still widens it", () => {
    const s2: InstalledPolicy = { policyName: "tax-alpha-allow-enr_vectorA01-s2", effect: "EFFECT_ALLOW", consensus: expected.allow.consensus, condition: supersededAllowPolicy(params, "s2-relay-close-bound").condition };
    const pol = base().map((p) => (p.condition === expected.allow.condition ? { ...p, policyName: "tax-alpha-allow-enr_vectorA01-s3" } : p));
    const r = verifyPosition(params, [...pol, s2]);
    expect(r.ok).toBe(true);
    expect(r.generation).toBe("s3");
    expect(r.supersededGenerations).toEqual(["s2"]);
    expect(failed(r)).toEqual([]);
    expect(r.checks.some((c) => c.id === "allow_superseded" && c.message.includes(SUPERSEDED_MESSAGES.s2))).toBe(true);
  });

  it("fails the tampered example export (an extra SOL redemption destination)", () => {
    const r = verifyPosition(V("position-b.params.json"), parsePolicyExport(V("position-b.export.json")));
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["allow_matches"]);
  });

  it("fails when the DENY is missing", () => {
    const r = verifyPosition(params, base().filter((p) => p.effect !== "EFFECT_DENY"));
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("deny_matches");
  });

  it("fails when the ALLOW is missing", () => {
    const r = verifyPosition(params, base().filter((p) => p.condition !== expected.allow.condition));
    expect(failed(r)).toContain("allow_matches");
  });

  it("is byte-exact: one extra space in the condition fails", () => {
    const pol = base().map((p) => (p.condition === expected.allow.condition ? { ...p, condition: p.condition.replace(" && ", "  && ") } : p));
    expect(failed(verifyPosition(params, pol))).toContain("allow_matches");
  });

  it("fails when the consensus names a different approver set", () => {
    const pol = base().map((p) => (p.condition === expected.allow.condition ? { ...p, consensus: `${p.consensus} || true` } : p));
    expect(failed(verifyPosition(params, pol))).toContain("allow_matches");
  });

  it("fails when the effect is flipped", () => {
    const pol = base().map((p) => (p.condition === expected.deny.condition ? { ...p, effect: "EFFECT_ALLOW" } : p));
    expect(verifyPosition(params, pol).ok).toBe(false);
  });

  it("fails on a second ALLOW for the same signer, even when the expected one is present", () => {
    const extra: InstalledPolicy = { policyName: "sneaky", effect: "EFFECT_ALLOW", consensus: expected.allow.consensus, condition: "activity.kind == 'SIGN_TRANSACTION'" };
    const r = verifyPosition(params, [...base(), extra]);
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["no_other_grants"]);
  });

  it("warns (does not fail) on an ALLOW whose approvers are not pinned to user ids", () => {
    const broad: InstalledPolicy = { policyName: "broad", effect: "EFFECT_ALLOW", consensus: "approvers.any(user, user.tags.contains('x'))", condition: "true" };
    const r = verifyPosition(params, [...base(), broad]);
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.id === "broad_allow" && c.status === "warn")).toBe(true);
  });

  it("an extra DENY naming the signer is informational only", () => {
    const deny: InstalledPolicy = { policyName: "extra-deny", effect: "EFFECT_DENY", consensus: expected.deny.consensus, condition: "true" };
    const r = verifyPosition(params, [...base(), deny]);
    expect(r.ok).toBe(true);
  });

  it("reports a policy-name mismatch as info, not failure", () => {
    const pol = base().map((p) => (p.condition === expected.allow.condition ? { ...p, policyName: "renamed" } : p));
    const r = verifyPosition(params, pol);
    expect(r.ok).toBe(true);
    expect(r.checks.some((c) => c.id === "allow_name" && c.status === "info")).toBe(true);
  });
});

describe("parsePolicyExport", () => {
  it("accepts the list_policies body or a bare array, and rejects anything else", () => {
    const body = V("position-a.export.json");
    expect(parsePolicyExport(body)).toHaveLength(3);
    expect(parsePolicyExport(body.policies)).toHaveLength(3);
    expect(() => parsePolicyExport({ foo: 1 })).toThrow();
    expect(() => parsePolicyExport([{ consensus: "x" }])).toThrow();
  });
});

describe("firstDifference", () => {
  it("locates the first differing character", () => {
    expect(firstDifference("abc", "abc")).toBe("identical");
    expect(firstDifference("abcd", "abXd")).toContain("character 2");
  });
});
