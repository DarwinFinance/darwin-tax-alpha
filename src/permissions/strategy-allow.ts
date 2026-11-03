// HAND-PORTED (see CHANGES-FROM-UPSTREAM.md). Upstream: src/lib/strategy/custody/strategy-allow.ts.
//
// The Turnkey ALLOW policy one Tax Alpha position installs in the user's own Turnkey sub-organization. Darwin
// signs for the position with a per-position, NON-ROOT Turnkey user that holds one API key; this policy is
// the whole of what that user may sign. It is installed with the user's passkey and never edited (a newer
// generation is installed as a new policy, and the old one deleted, by the in-app "Security update").
// Three alternatives, OR'd:
//
//   SWAP          a dFlow (or Jupiter fallback) swap inside the position's own wallet — agent-spot-allow.ts —
//                 and, from generation s2, every SPL Token instruction is a CloseAccount into the position
//                 wallet itself (`strategyClosesToSelfClause`): no token-account close pays anyone else.
//   TOKEN REDEEM  SPL `TransferChecked` (opcode 0c) ONLY, from the position wallet, into one of the user's own
//                 associated token accounts (for the listed redemption mints, both token programs); optionally
//                 a `CreateIdempotent` (01) of such an account, owned by one of the user's own wallets.
//   SOL REDEEM    System `Transfer` (02000000) ONLY, from the position wallet to one of the user's own wallets;
//                 optionally ONE `CloseAccount` (09) of the position wallet's own wSOL account into itself.
//
// Every alternative carries the compute-budget (priority fee) bound, and both redemptions forbid address
// lookup tables (an account loaded through a table is invisible to the positional account checks).
//
// GENERATIONS (an installed ALLOW is immutable, so an older one can still be installed):
//   s1-agent-v9-swap      SUPERSEDED. The swap alternative is the agent spot ALLOW v9. It let the position key
//                         close the wallet's wrapped-SOL account to Darwin's relay (paying out the wrapped SOL),
//                         and pay the relay a rent "payback" beside an idempotent create that put no rent in.
//   s2-relay-close-bound  CURRENT. The swap alternative is the agent spot ALLOW v10 `&&` every Token close pays
//                         the position wallet. Installed by every position created from 2026-11-03; an older
//                         position moves to it through the in-app "Security update".
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { COMPUTE_BUDGET_BOUND } from "./compute-budget-bound";
import { activityKindIn, assertSafeToken } from "./policy-text";
import { selfAddressAllowlist } from "./self-address-allowlist";
import { COMPUTE_BUDGET_PROGRAM, NEVER_A_TABLE_KEY, SYSTEM_PROGRAM, WSOL_MINT, spotAllowCondition, type SpotAllowShape } from "./agent-spot-allow";

export { COMPUTE_BUDGET_BOUND };
export { DFLOW_ROUTER } from "./agent-spot-allow";

const COMPUTE_BUDGET = COMPUTE_BUDGET_PROGRAM;
const SYSTEM = SYSTEM_PROGRAM;
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();
const ATA = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const KIND = activityKindIn("SIGN_TRANSACTION");
const NO_LOOKUP_TABLES = `solana.tx.address_table_lookups.all(l, l.address_table_key in ['${NEVER_A_TABLE_KEY}'])`;

export type StrategyAllowArgs = {
  /** The position's wallet address — the only wallet this policy lets the position key sign with. */
  strategyWallet: string;
  /** The user's own wallets a redemption may pay. Never the position wallet itself. */
  userWallets: readonly string[];
  /** Mints a token redemption may deliver (USDC plus the strategy's members at enrollment). */
  redemptionMints: readonly string[];
  /**
   * Darwin's fee-paying relay wallet. It appears in the SWAP alternative only: Darwin pays transaction fees
   * and the rent of a temporary wSOL account, and a swap may pay back that rent (at most 1,488,440 lamports,
   * only in the transaction where the relay's create deposits it). Under s2 no token-account close may pay
   * the relay. The same for every position, but supplied as a parameter (it is not published here).
   */
  darwinRelayWallet: string;
};

const quoted = (xs: readonly string[], label: string) =>
  xs.map((x, i) => `'${assertSafeToken(x, `${label}[${i}]`)}'`).join(", ");

function validate(args: StrategyAllowArgs): void {
  new PublicKey(args.strategyWallet);
  if (args.userWallets.length === 0) throw new Error("strategyAllow: no user wallets — a redemption could pay no one");
  if (args.userWallets.includes(args.strategyWallet)) throw new Error("strategyAllow: the strategy wallet cannot be its own redemption destination");
  if (args.redemptionMints.length === 0) throw new Error("strategyAllow: no redemption mints");
}

/** The strategy ALLOW's generations, oldest first. */
export type StrategyAllowGeneration = "s1-agent-v9-swap" | "s2-relay-close-bound";
export const ALL_STRATEGY_ALLOW_GENERATIONS: readonly StrategyAllowGeneration[] = ["s1-agent-v9-swap", "s2-relay-close-bound"];
/** What every new position installs, and what the "Security update" moves an older position to. */
export const CURRENT_STRATEGY_ALLOW_GENERATION: StrategyAllowGeneration = "s2-relay-close-bound";

/** The agent spot generation each strategy generation is pinned to. */
const AGENT_SHAPE_FOR: Readonly<Record<StrategyAllowGeneration, SpotAllowShape>> = {
  "s1-agent-v9-swap": "v9-priority-fee-bound",
  "s2-relay-close-bound": "v10-relay-close-bound",
};

/**
 * s2: EVERY SPL Token instruction in the transaction is a three-account instruction whose account [1] (a
 * CloseAccount's destination; the swap rule already pins the data to '09' and the authority to the wallet) is
 * the position wallet itself.
 */
export function strategyClosesToSelfClause(strategyWallet: string): string {
  const wallet = assertSafeToken(strategyWallet, "strategy wallet");
  return `solana.tx.instructions.filter(i, i.program_key == '${TOKEN}').all(j, j.accounts.count() == 3 && j.accounts[1].account_key == '${wallet}')`;
}

/** SWAP — the agent spot ALLOW text, bound to the position wallet (agent-spot-allow.ts), at `generation`. */
export function strategySwapClause(strategyWallet: string, darwinRelayWallet: string, generation: StrategyAllowGeneration = CURRENT_STRATEGY_ALLOW_GENERATION): string {
  const agent = spotAllowCondition(strategyWallet, darwinRelayWallet, AGENT_SHAPE_FOR[generation]);
  return generation === "s1-agent-v9-swap" ? agent : `${agent} && ${strategyClosesToSelfClause(strategyWallet)}`;
}

/** TOKEN REDEEM — TransferChecked to the user's own ATAs only. */
export function strategyTokenRedeemClause(args: StrategyAllowArgs): string {
  const { atas } = selfAddressAllowlist([...args.userWallets], [...args.redemptionMints]);
  const dest = quoted(atas, "user ATA");
  const owners = quoted(args.userWallets, "user wallet");
  const wallet = assertSafeToken(args.strategyWallet, "strategy wallet");
  return `${KIND} && ${NO_LOOKUP_TABLES} && ${COMPUTE_BUDGET_BOUND}`
    + ` && solana.tx.instructions.all(i, i.program_key in ['${COMPUTE_BUDGET}', '${TOKEN}', '${TOKEN_2022}', '${ATA}'])`
    + ` && solana.tx.instructions.any(i, i.program_key in ['${TOKEN}', '${TOKEN_2022}'])`
    + ` && solana.tx.instructions.filter(i, i.program_key in ['${TOKEN}', '${TOKEN_2022}']).all(j, j.instruction_data_hex[0..2] == '0c'`
    + ` && j.accounts.count() == 4 && j.accounts[2].account_key in [${dest}] && j.accounts[3].account_key == '${wallet}')`
    + ` && solana.tx.instructions.filter(i, i.program_key == '${ATA}').all(j, j.instruction_data_hex == '01'`
    + ` && j.accounts[1].account_key in [${dest}] && j.accounts[2].account_key in [${owners}])`;
}

/** SOL REDEEM — a System Transfer from the position wallet to one of the user's own wallets. */
export function strategySolRedeemClause(args: StrategyAllowArgs): string {
  const owners = quoted(args.userWallets, "user wallet");
  const wallet = assertSafeToken(args.strategyWallet, "strategy wallet");
  const wsolAta = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), new PublicKey(wallet), true, TOKEN_PROGRAM_ID).toBase58();
  return `${KIND} && ${NO_LOOKUP_TABLES} && ${COMPUTE_BUDGET_BOUND}`
    + ` && solana.tx.instructions.all(i, i.program_key in ['${COMPUTE_BUDGET}', '${SYSTEM}', '${TOKEN}'])`
    + ` && solana.tx.instructions.any(i, i.program_key == '${SYSTEM}')`
    + ` && solana.tx.instructions.filter(i, i.program_key == '${TOKEN}').all(j, j.instruction_data_hex == '09'`
    + ` && j.accounts.count() == 3 && j.accounts[0].account_key == '${wsolAta}' && j.accounts[1].account_key == '${wallet}' && j.accounts[2].account_key == '${wallet}')`
    + ` && solana.tx.instructions.filter(i, i.program_key == '${SYSTEM}').all(j, j.instruction_data_hex[0..8] == '02000000'`
    + ` && j.accounts.count() == 2 && j.accounts[0].account_key == '${wallet}' && j.accounts[1].account_key in [${owners}])`;
}

/** The whole ALLOW condition: swap OR token redemption OR SOL redemption. */
export function strategyAllowCondition(args: StrategyAllowArgs, generation: StrategyAllowGeneration = CURRENT_STRATEGY_ALLOW_GENERATION): string {
  validate(args);
  return `(${strategySwapClause(args.strategyWallet, args.darwinRelayWallet, generation)}) || (${strategyTokenRedeemClause(args)}) || (${strategySolRedeemClause(args)})`;
}

export const STRATEGY_ALLOW_NOTES = "Tax Alpha strategy key: dFlow swaps in its own wallet, redemptions only to the user's own wallets. Installed by the user's passkey.";

export function strategyAllowPolicyName(enrollmentId: string): string {
  if (!enrollmentId) throw new Error("strategyAllowPolicyName requires an enrollment id");
  return `tax-alpha-allow-${assertSafeToken(enrollmentId, "enrollment id")}`;
}

/**
 * The name of the ALLOW a security update installs (Turnkey names are unique, and the old ALLOW is still
 * installed when the new one is created): `tax-alpha-allow-<id>-s2`.
 */
export function strategyAllowUpgradePolicyName(setupId: string): string {
  return `${strategyAllowPolicyName(setupId)}-${CURRENT_STRATEGY_ALLOW_GENERATION.split("-")[0]}`;
}

/** Every name a position's ALLOW may carry (as set up, or after its security update). */
export function strategyAllowPolicyNames(setupId: string): string[] {
  return [strategyAllowPolicyName(setupId), strategyAllowUpgradePolicyName(setupId)];
}

/** The CREATE_POLICY body for one position. Consensus binds the position's OWN user, never another. */
export function buildStrategyAllowPolicyBody(args: StrategyAllowArgs & { enrollmentId: string; strategyUserId: string }) {
  if (!args.strategyUserId) throw new Error("buildStrategyAllowPolicyBody requires the strategy user id");
  return {
    policyName: strategyAllowPolicyName(args.enrollmentId),
    effect: "EFFECT_ALLOW" as const,
    consensus: `approvers.any(user, user.id == '${assertSafeToken(args.strategyUserId, "strategy user id")}')`,
    condition: strategyAllowCondition(args),
    notes: STRATEGY_ALLOW_NOTES,
  };
}
