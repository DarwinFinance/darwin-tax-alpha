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
  supersededAllowPolicy, validatePositionParams, dflowAtaCreatesOwnedClause, dflowWrapSolTargetClause,
  strategyAllowGenerationPolicyName, jupiterOnlyBranchClauses, dflowInstructionsFor, DFLOW_NAMES_DROPPED_AT_V12,
} from "../src/permissions";

const V = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "vectors", name), "utf8"));

// Random keys generated for these tests; never funded, not anyone's wallet.
const WALLET = "GFLWwatD5mHm7hnbqbppkBa5fWHuPeTmeHhgAcDM52qe";
const USER = "EeGDyss3gpp2XmFrw2TrNRqWfkoF6Bh6UZQJfVAg8yQr";
const RELAY = "4PgS7gTwP3DsbKo3D6ChcftCZkkejUa67QaW5z63remk";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const args = { strategyWallet: WALLET, userWallets: [USER], redemptionMints: [USDC], darwinRelayWallet: RELAY };

describe("test vectors (rendered by the upstream builder)", () => {
  for (const v of ["position-a", "position-b", "position-c", "position-d", "position-e"]) {
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

  it("swap (s5): Turnkey must be signing WITH the position wallet; the Jupiter-only branch, then the priority-fee bound", () => {
    const c = strategySwapClause(WALLET, RELAY);
    expect(c).toBe(`activity.kind == 'SIGN_TRANSACTION' && wallet_account.address == '${WALLET}' && (${jupiterOnlyBranchClauses(WALLET, RELAY).join(" && ")}) && ${COMPUTE_BUDGET_BOUND}`);
    // No dFlow, no transfer or close to the relay, no closes-to-self clause (v13's own Token bound is narrower).
    expect(c).not.toContain("DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");
    expect(c).not.toContain("solana.tx.transfers");
    expect(c).not.toContain(strategyClosesToSelfClause(WALLET));
    // The relay appears once: as an allowed payer of an ATA create owned by the wallet.
    expect(c.split(RELAY).length - 1).toBe(1);
    expect(c).toContain(`j.accounts[2].account_key == '${WALLET}' && j.accounts[0].account_key in ['${WALLET}', '${RELAY}']`);
  });

  it("s5 (CURRENT) is the agent v13 spot text alone", () => {
    expect(CURRENT_STRATEGY_ALLOW_GENERATION).toBe("s5-jupiter-only");
    expect(strategySwapClause(WALLET, RELAY)).toBe(spotAllowCondition(WALLET, RELAY, "v13-jupiter-only"));
    expect(strategySwapClause(WALLET, RELAY, "s4-dflow-names-narrowed")).toBe(`${spotAllowCondition(WALLET, RELAY, "v12-dflow-names-narrowed")} && ${strategyClosesToSelfClause(WALLET)}`);
    expect(strategySwapClause(WALLET, RELAY, "s3-dflow-accounts-bound")).toBe(`${spotAllowCondition(WALLET, RELAY, "v11-dflow-accounts-bound")} && ${strategyClosesToSelfClause(WALLET)}`);
    expect(strategySwapClause(WALLET, RELAY, "s2-relay-close-bound")).toBe(`${spotAllowCondition(WALLET, RELAY, "v10-relay-close-bound")} && ${strategyClosesToSelfClause(WALLET)}`);
    expect(strategyClosesToSelfClause(WALLET)).toBe(`solana.tx.instructions.filter(i, i.program_key == 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').all(j, j.accounts.count() == 3 && j.accounts[1].account_key == '${WALLET}')`);
  });

  it("v13: the output [6] is an in-transaction ATA create the wallet owns; the wallet appears once; [9] is none; wSOL only", () => {
    const c = jupiterOnlyBranchClauses(WALLET, RELAY).join(" && ");
    const wsol = agentWsolAta(WALLET);
    expect(c).toContain(`j.accounts[2].account_key == '${WALLET}' && j.accounts[9].account_key == 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' && j.accounts.filter(a, a.account_key == '${WALLET}').count() == 1`);
    expect(c).toContain(`c.accounts[1].account_key == j.accounts[6].account_key && c.accounts[2].account_key == '${WALLET}'`);
    expect(c).toContain("solana.tx.instructions.filter(i, i.program_key == 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL').count() <= 2");
    expect(c).toContain(`j.instruction_data_hex[0..8] == '02000000' && j.accounts.count() == 2 && j.accounts[0].account_key == '${WALLET}' && j.accounts[1].account_key == '${wsol}'`);
    expect(c).toContain(`j.instruction_data_hex in ['09', '11'] && j.accounts.count() > 0 && j.accounts[0].account_key == '${wsol}'`);
    expect(c).toContain(`j.accounts.count() == 3 && j.accounts[1].account_key == '${WALLET}' && j.accounts[2].account_key == '${WALLET}'`);
    expect(c.endsWith("solana.tx.address_table_lookups.all(l, l.address_table_key in ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'])")).toBe(true);
  });

  it("v12 is v11 with the dFlow discriminator lists narrowed to swap, swap2, wrap_sol, unwrap_sol", () => {
    expect(dflowInstructionsFor("v12-dflow-names-narrowed").map(([n]) => n)).toEqual(["swap", "swap2", "wrap_sol", "unwrap_sol"]);
    const v12 = spotAllowCondition(WALLET, RELAY, "v12-dflow-names-narrowed");
    const v11 = spotAllowCondition(WALLET, RELAY, "v11-dflow-accounts-bound");
    const full = dflowInstructionsFor("v11-dflow-accounts-bound");
    const dropped = full.filter(([n]) => DFLOW_NAMES_DROPPED_AT_V12.includes(n)).map(([, h]) => h);
    expect(dropped).toHaveLength(3);
    for (const h of dropped) { expect(v11).toContain(`'${h}'`); expect(v12).not.toContain(`'${h}'`); }
    const list = (xs: readonly (readonly [string, string])[]) => `[${xs.map(([, h]) => `'${h}'`).join(", ")}]`;
    expect(v12).toBe(v11.split(list(full)).join(list(dflowInstructionsFor("v12-dflow-names-narrowed"))));
  });

  it("v11 is v10 plus, inside the dFlow branch only, the ATA-owner and wrap_sol-target bounds", () => {
    const v11 = spotAllowCondition(WALLET, RELAY, "v11-dflow-accounts-bound");
    const v10 = spotAllowCondition(WALLET, RELAY, "v10-relay-close-bound");
    const ata = dflowAtaCreatesOwnedClause(WALLET, RELAY);
    const wrap = dflowWrapSolTargetClause(WALLET);
    expect(ata).toBe(`solana.tx.instructions.filter(i, i.program_key == 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL').all(j, j.accounts.count() > 2 && j.accounts[0].account_key in ['${WALLET}', '${RELAY}'] && j.accounts[2].account_key == '${WALLET}')`);
    expect(wrap).toBe(`solana.tx.instructions.filter(i, i.program_key == 'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH').all(j, j.instruction_data_hex[0..16] != '2f3e9bac83cd25c9' || j.accounts[1].account_key == '${agentWsolAta(WALLET)}')`);
    // The two conjuncts close the dFlow branch; the Jupiter branch and the compute-budget bound are v10's.
    const dflowEnd = ` && ${ata} && ${wrap})`;
    expect(v11).toContain(dflowEnd);
    expect(v11.replace(` && ${ata} && ${wrap}`, "")).toBe(v10);
    expect(v10).not.toContain(wrap);
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

  it("s1 to s4 (superseded) differ from s5 only in the swap alternative; redemptions and consensus are identical", () => {
    expect(strategySwapClause(WALLET, RELAY, "s1-agent-v9-swap")).toBe(spotAllowCondition(WALLET, RELAY, "v9-priority-fee-bound"));
    const p = V("position-a.params.json");
    const s5 = expectedPositionPolicies(p).allow;
    type G = "s1-agent-v9-swap" | "s2-relay-close-bound" | "s3-dflow-accounts-bound" | "s4-dflow-names-narrowed" | "s5-jupiter-only";
    const tail = (c: string, g: G) => c.slice(`(${strategySwapClause(p.strategyWallet, p.darwinRelayWallet, g)})`.length);
    const olds = (["s1-agent-v9-swap", "s2-relay-close-bound", "s3-dflow-accounts-bound", "s4-dflow-names-narrowed"] as const).map((g) => {
      const old = supersededAllowPolicy(p, g);
      expect(old.condition).not.toBe(s5.condition);
      expect(tail(old.condition, g)).toBe(tail(s5.condition, "s5-jupiter-only"));
      expect(old.consensus).toBe(s5.consensus);
      return old.condition;
    });
    expect(new Set(olds).size).toBe(4);
  });

  it("names: a position's ALLOW, and the ones its security updates install", () => {
    expect(strategyAllowPolicyNames("setup1")).toEqual(["tax-alpha-allow-setup1", "tax-alpha-allow-setup1-s2", "tax-alpha-allow-setup1-s3", "tax-alpha-allow-setup1-s4", "tax-alpha-allow-setup1-s5"]);
    expect(strategyAllowUpgradePolicyName("setup1")).toBe("tax-alpha-allow-setup1-s5");
    expect(strategyAllowGenerationPolicyName("setup1", "s2-relay-close-bound")).toBe("tax-alpha-allow-setup1-s2");
    expect(strategyAllowGenerationPolicyName("setup1", "s4-dflow-names-narrowed")).toBe("tax-alpha-allow-setup1-s4");
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
