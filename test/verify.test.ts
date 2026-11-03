import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstDifference, parsePolicyExport, verifyPosition, type InstalledPolicy } from "../src/verify";

const V = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "vectors", name), "utf8"));
const params = V("position-a.params.json");
const expected = V("position-a.expected.json");
const base = (): InstalledPolicy[] => parsePolicyExport(V("position-a.export.json"));
const failed = (r: ReturnType<typeof verifyPosition>) => r.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("verifyPosition", () => {
  it("passes the clean example export", () => {
    const r = verifyPosition(params, base());
    expect(r.ok).toBe(true);
    expect(failed(r)).toEqual([]);
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
