// Adapted from upstream src/lib/strategy/custody/strategy-allow.test.ts, plus the byte-exact test vectors
// (test/vectors/*.expected.json are rendered by the UPSTREAM builder in scripts/sync.ts).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  AGENT_DENY_CONDITION, COMPUTE_BUDGET_BOUND, buildStrategyAllowPolicyBody, buildStrategyDenyPolicyBody,
  CURRENT_STRATEGY_ALLOW_GENERATION, agentWsolAta, expectedPositionPolicies, spotAllowCondition,
  strategyAllowCondition, strategyAllowPolicyName, strategyAllowPolicyNames, strategyAllowUpgradePolicyName,
  strategyClosesToSelfClause, strategySolRedeemClause, strategySwapClause, strategyTokenRedeemClause,
  supersededAllowPolicy, validatePositionParams,
} from "../src/permissions";

const V = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "vectors", name), "utf8"));

// Random keys generated for these tests; never funded, not anyone's wallet.
const WALLET = "GFLWwatD5mHm7hnbqbppkBa5fWHuPeTmeHhgAcDM52qe";
const USER = "EeGDyss3gpp2XmFrw2TrNRqWfkoF6Bh6UZQJfVAg8yQr";
const RELAY = "4PgS7gTwP3DsbKo3D6ChcftCZkkejUa67QaW5z63remk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const args = { strategyWallet: WALLET, userWallets: [USER], redemptionMints: [USDC], darwinRelayWallet: RELAY };

describe("test vectors (rendered by the upstream builder)", () => {
  for (const v of ["position-a", "position-b", "position-c"]) {
    it(`${v}: this repository renders the ALLOW and DENY byte for byte`, () => {
      expect(expectedPositionPolicies(V(`${v}.params.json`))).toEqual(V(`${v}.expected.json`));
    });
  }
  it("without an enrollment id the names are null and the security text is unchanged", () => {
    const p = V("position-a.params.json");
    const { enrollmentId: _drop, ...rest } = p;
    const got = expectedPositionPolicies(rest);
    const want = V("position-a.expected.json");
    expect(got.allow.policyName).toBeNull();
    expect(got.allow.condition).toBe(want.allow.condition);
    expect(got.deny.condition).toBe(want.deny.condition);
    expect(got.allow.consensus).toBe(want.allow.consensus);
  });
});

describe("strategy ALLOW", () => {
  it("is swap OR token redemption OR SOL redemption, each a complete alternative", () => {
    expect(strategyAllowCondition(args)).toBe(`(${strategySwapClause(WALLET, RELAY)}) || (${strategyTokenRedeemClause(args)}) || (${strategySolRedeemClause(args)})`);
  });

  it("swap: Turnkey must be signing WITH the position wallet; the priority-fee bound then the closes-to-self bound end it", () => {
    const c = strategySwapClause(WALLET, RELAY);
    expect(c.startsWith(`activity.kind == 'SIGN_TRANSACTION' && wallet_account.address == '${WALLET}' && (`)).toBe(true);
    expect(c.endsWith(` && ${COMPUTE_BUDGET_BOUND} && ${strategyClosesToSelfClause(WALLET)}`)).toBe(true);
    // The only transfer a swap may carry is the bounded rent payback to the relay.
    expect(c).toContain(`solana.tx.transfers.all(t, t.from == '${WALLET}' && t.to == '${RELAY}' && t.amount < 1488441)`);
  });

  it("s2 (CURRENT) is the agent v10 spot text && every Token close pays the position wallet itself", () => {
    expect(CURRENT_STRATEGY_ALLOW_GENERATION).toBe("s2-relay-close-bound");
    expect(strategySwapClause(WALLET, RELAY)).toBe(`${spotAllowCondition(WALLET, RELAY, "v10-relay-close-bound")} && ${strategyClosesToSelfClause(WALLET)}`);
    expect(strategyClosesToSelfClause(WALLET)).toBe(`solana.tx.instructions.filter(i, i.program_key == 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').all(j, j.accounts.count() == 3 && j.accounts[1].account_key == '${WALLET}')`);
  });

  it("v10: a rent payback rides only the relay's NON-idempotent create; v9 also accepted the idempotent one", () => {
    const v10 = spotAllowCondition(WALLET, RELAY, "v10-relay-close-bound");
    const v9 = spotAllowCondition(WALLET, RELAY, "v9-priority-fee-bound");
    const payback = (hex: string) => `solana.tx.instructions.any(i, i.program_key == 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && ${hex} && i.accounts.count() > 2 && i.accounts[0].account_key == '${RELAY}' && i.accounts[1].account_key == '${agentWsolAta(WALLET)}'`;
    expect(v10).toContain(payback("i.instruction_data_hex == '00'"));
    expect(v10).not.toContain(payback("i.instruction_data_hex in ['00', '01']"));
    expect(v9).toContain(payback("i.instruction_data_hex in ['00', '01']"));
  });

  it("v10: a close to the relay must be of a fresh, relay-created account that is not the wallet's wSOL account", () => {
    const v10 = spotAllowCondition(WALLET, RELAY, "v10-relay-close-bound");
    expect(v10).toContain(`j.accounts[0].account_key != '${agentWsolAta(WALLET)}'`);
    expect(v10).toContain(`c.instruction_data_hex == '00' && c.accounts.count() > 2 && c.accounts[0].account_key == '${RELAY}' && c.accounts[1].account_key == j.accounts[0].account_key && c.accounts[2].account_key == '${WALLET}'`);
    expect(spotAllowCondition(WALLET, RELAY, "v9-priority-fee-bound")).not.toContain(`!= '${agentWsolAta(WALLET)}'`);
  });

  it("s1 (superseded) is the agent v9 spot text with no closes-to-self bound; redemptions are identical", () => {
    expect(strategySwapClause(WALLET, RELAY, "s1-agent-v9-swap")).toBe(spotAllowCondition(WALLET, RELAY, "v9-priority-fee-bound"));
    const p = V("position-a.params.json");
    const s1 = supersededAllowPolicy(p);
    const s2 = expectedPositionPolicies(p).allow;
    expect(s1.condition).not.toBe(s2.condition);
    const tail = (c: string, g: "s1-agent-v9-swap" | "s2-relay-close-bound") => c.slice(`(${strategySwapClause(p.strategyWallet, p.darwinRelayWallet, g)})`.length);
    expect(tail(s1.condition, "s1-agent-v9-swap")).toBe(tail(s2.condition, "s2-relay-close-bound"));
    expect(s1.consensus).toBe(s2.consensus);
  });

  it("names: a position's ALLOW, and the one its security update installs", () => {
    expect(strategyAllowPolicyNames("setup1")).toEqual(["tax-alpha-allow-setup1", "tax-alpha-allow-setup1-s2"]);
    expect(strategyAllowUpgradePolicyName("setup1")).toBe("tax-alpha-allow-setup1-s2");
  });

  it("token redemption admits TransferChecked only, to the user's own ATAs, owned by the position wallet", () => {
    const c = strategyTokenRedeemClause(args);
    const userAta = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(USER), true).toBase58();
    expect(c).toContain("instruction_data_hex[0..2] == '0c'");
    expect(c).toContain(`'${userAta}'`);
    expect(c).toContain(`j.accounts[3].account_key == '${WALLET}'`);
    expect(c).not.toContain("'04'"); // Approve
    expect(c).not.toContain(RELAY);
  });

  it("SOL redemption admits a System Transfer from the position wallet to the user only — never the relay", () => {
    const c = strategySolRedeemClause(args);
    expect(c).toContain("instruction_data_hex[0..8] == '02000000'");
    expect(c).toContain(`j.accounts[0].account_key == '${WALLET}'`);
    expect(c).toContain(`j.accounts[1].account_key in ['${USER}']`);
    expect(c).not.toContain(RELAY);
  });

  it("every alternative bounds the priority fee, and both redemptions forbid lookup tables", () => {
    for (const c of [strategySwapClause(WALLET, RELAY), strategyTokenRedeemClause(args), strategySolRedeemClause(args)]) expect(c).toContain(COMPUTE_BUDGET_BOUND);
    for (const c of [strategyTokenRedeemClause(args), strategySolRedeemClause(args)]) expect(c).toContain("solana.tx.address_table_lookups.all(");
  });

  it("fails closed on unusable inputs", () => {
    expect(() => strategyAllowCondition({ ...args, userWallets: [] })).toThrow();
    expect(() => strategyAllowCondition({ ...args, userWallets: [WALLET] })).toThrow();
    expect(() => strategyAllowCondition({ ...args, redemptionMints: [] })).toThrow();
    expect(() => strategyAllowCondition({ ...args, strategyWallet: "not-a-key" })).toThrow();
    expect(() => strategyAllowCondition({ ...args, darwinRelayWallet: "not-a-key" })).toThrow();
    expect(() => strategyAllowCondition({ ...args, userWallets: ["x' || true || '"] })).toThrow();
  });

  it("binds consensus to the position's OWN user and names the policy per enrollment", () => {
    const body = buildStrategyAllowPolicyBody({ ...args, enrollmentId: "enr_123", strategyUserId: "user-abc" });
    expect(body.consensus).toBe("approvers.any(user, user.id == 'user-abc')");
    expect(body.effect).toBe("EFFECT_ALLOW");
    expect(body.policyName).toBe(strategyAllowPolicyName("enr_123"));
    expect(() => buildStrategyAllowPolicyBody({ ...args, enrollmentId: "enr_123", strategyUserId: "" })).toThrow();
    expect(() => buildStrategyAllowPolicyBody({ ...args, enrollmentId: "enr_123", strategyUserId: "u') || true || ('" })).toThrow();
  });
});

describe("strategy DENY", () => {
  it("denies credential and MFA management and raw signing, for the position's own user", () => {
    const body = buildStrategyDenyPolicyBody({ enrollmentId: "enr_123", strategyUserId: "user-abc" });
    expect(body.effect).toBe("EFFECT_DENY");
    expect(body.condition).toBe(AGENT_DENY_CONDITION);
    expect(body.condition).toBe("activity.resource in ['CREDENTIAL','MFA_POLICY'] || activity.kind in ['SIGN_RAW_PAYLOAD','SIGN_RAW_PAYLOADS','SOL_SEND_TRANSACTION']");
    expect(body.consensus).toBe("approvers.any(user, user.id == 'user-abc')");
    expect(body.policyName).toBe("tax-alpha-deny-enr_123");
  });
});

describe("parameter validation", () => {
  it("accepts the vectors and rejects malformed parameters", () => {
    expect(() => validatePositionParams(V("position-a.params.json"))).not.toThrow();
    expect(() => validatePositionParams({ ...V("position-a.params.json"), userWallets: [] })).toThrow();
    expect(() => validatePositionParams({ ...V("position-a.params.json"), strategyUserId: "a b" })).toThrow();
    expect(() => validatePositionParams({ ...V("position-a.params.json"), darwinRelayWallet: undefined })).toThrow();
    expect(() => validatePositionParams(null)).toThrow();
  });
});
