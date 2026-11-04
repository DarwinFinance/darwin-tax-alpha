/**
 * The parameters that identify one Tax Alpha position, and the two policies (ALLOW + DENY) that position
 * installs in the user's Turnkey sub-organization, rendered exactly.
 */
import { PublicKey } from "@solana/web3.js";
import {
  buildStrategyAllowPolicyBody, strategyAllowCondition, strategyAllowPolicyName, strategyAllowPolicyNames,
  CURRENT_STRATEGY_ALLOW_GENERATION, type StrategyAllowGeneration,
} from "./strategy-allow";
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

/**
 * The exact ALLOW and DENY a position with these parameters installs today (the CURRENT strategy generation,
 * `s3-dflow-accounts-bound`). A position whose ALLOW was installed by its security update carries the same text
 * under the name `tax-alpha-allow-<id>-s3` (see `acceptedAllowPolicyNames`).
 */
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

/** The strategy generation `expectedPositionPolicies` renders. */
export const CURRENT_GENERATION: StrategyAllowGeneration = CURRENT_STRATEGY_ALLOW_GENERATION;

/** The older generations the verifier recognises as SUPERSEDED (not a mismatch), oldest first. */
export type SupersededGeneration = Exclude<StrategyAllowGeneration, "s3-dflow-accounts-bound">;
export const SUPERSEDED_GENERATIONS: readonly SupersededGeneration[] = ["s1-agent-v9-swap", "s2-relay-close-bound"];

/**
 * The ALLOW of an older, SUPERSEDED generation, which a position keeps until the user runs the in-app
 * "Security update":
 *   s1-agent-v9-swap      positions created before 2026-11-03 (lacks the relay-close bound and the dFlow
 *                         account bounds);
 *   s2-relay-close-bound  positions created, or updated, on 2026-11-03 before the s3 release that night (lacks
 *                         the dFlow `wrap_sol` / ATA-owner bounds).
 * Same redemption alternatives and consensus; only the swap alternative differs. The verifier recognises these
 * so it can say "superseded" instead of "mismatch". The name is the set-up name (an s2 ALLOW installed by an
 * s1 → s2 update is named `…-s2`; names are informational).
 */
export function supersededAllowPolicy(params: PositionParams, generation: SupersededGeneration): ExpectedPolicy {
  validatePositionParams(params);
  const current = expectedPositionPolicies(params).allow;
  return {
    policyName: params.enrollmentId !== undefined ? strategyAllowPolicyName(params.enrollmentId) : null,
    effect: current.effect,
    consensus: current.consensus,
    condition: strategyAllowCondition(params, generation),
    notes: current.notes,
  };
}

/** Names a position's ALLOW may carry: as set up, or as installed by any security update. Informational. */
export function acceptedAllowPolicyNames(params: PositionParams): string[] {
  return params.enrollmentId !== undefined ? strategyAllowPolicyNames(params.enrollmentId) : [];
}
