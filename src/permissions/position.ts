/**
 * The parameters that identify one Tax Alpha position, and the two policies (ALLOW + DENY) that position
 * installs in the user's Turnkey sub-organization, rendered exactly.
 */
import { PublicKey } from "@solana/web3.js";
import { buildStrategyAllowPolicyBody } from "./strategy-allow";
import { buildStrategyDenyPolicyBody } from "./strategy-deny";

export interface PositionParams {
  /** The position's own wallet address (Solana, base58). */
  strategyWallet: string;
  /** The Turnkey user id of the position's non-root signer (the only approver both policies name). */
  strategyUserId: string;
  /** The user's own wallets that redemptions may pay, as shown to the user. */
  userWallets: string[];
  /** Mints a token redemption may deliver (USDC plus the strategy's members at enrollment). */
  redemptionMints: string[];
  /** Darwin's fee-paying relay wallet (appears only in the swap alternative; see strategy-allow.ts). */
  darwinRelayWallet: string;
  /** Optional: the position's enrollment id. Only used to predict the policy NAMES, which are not security relevant. */
  enrollmentId?: string;
}

export interface ExpectedPolicy {
  /** null when no enrollment id was given (names are informational only). */
  policyName: string | null;
  effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  consensus: string;
  condition: string;
  notes: string;
}

export interface ExpectedPositionPolicies {
  allow: ExpectedPolicy;
  deny: ExpectedPolicy;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Throws a readable error for parameters that cannot describe a position. */
export function validatePositionParams(p: unknown): asserts p is PositionParams {
  if (!p || typeof p !== "object") throw new Error("parameters must be a JSON object");
  const o = p as Record<string, unknown>;
  const addr = (v: unknown, label: string) => {
    if (typeof v !== "string" || !SOLANA_ADDRESS.test(v)) throw new Error(`${label} must be a base58 Solana address`);
    new PublicKey(v);
  };
  addr(o.strategyWallet, "strategyWallet");
  addr(o.darwinRelayWallet, "darwinRelayWallet");
  if (typeof o.strategyUserId !== "string" || !SAFE_ID.test(o.strategyUserId)) throw new Error("strategyUserId must be a Turnkey user id");
  for (const k of ["userWallets", "redemptionMints"] as const) {
    if (!Array.isArray(o[k]) || (o[k] as unknown[]).length === 0) throw new Error(`${k} must be a non-empty array`);
    (o[k] as unknown[]).forEach((v, i) => addr(v, `${k}[${i}]`));
  }
  if (o.enrollmentId !== undefined && (typeof o.enrollmentId !== "string" || !SAFE_ID.test(o.enrollmentId))) {
    throw new Error("enrollmentId, when given, must be [A-Za-z0-9_-]");
  }
}

/** The exact ALLOW and DENY a position with these parameters installs. */
export function expectedPositionPolicies(params: PositionParams): ExpectedPositionPolicies {
  validatePositionParams(params);
  const enrollmentId = params.enrollmentId ?? "unknown";
  const allow = buildStrategyAllowPolicyBody({ ...params, enrollmentId });
  const deny = buildStrategyDenyPolicyBody({ enrollmentId, strategyUserId: params.strategyUserId });
  const named = params.enrollmentId !== undefined;
  return {
    allow: { policyName: named ? allow.policyName : null, effect: allow.effect, consensus: allow.consensus, condition: allow.condition, notes: allow.notes },
    deny: { policyName: named ? deny.policyName : null, effect: deny.effect, consensus: deny.consensus, condition: deny.condition, notes: deny.notes },
  };
}
