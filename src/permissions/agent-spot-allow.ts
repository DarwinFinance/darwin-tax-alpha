// HAND-PORTED (see CHANGES-FROM-UPSTREAM.md). Mirrors the upstream agent spot ALLOW at the generation the
// Tax Alpha strategy ALLOW is pinned to ("v9-priority-fee-bound"): `buildAgentAllowCondition` with
// `venue: "spot"`, and the pieces it composes (venue predicate, relay rent payback, token close, Jupiter
// fallback branch, compute-budget bound). Upstream renders every venue and every historical generation from
// one registry; this file renders only the one text a Tax Alpha position installs, in the same order, so the
// output is byte-identical. scripts/sync.ts checks that equality against upstream on every sync.
//
// Turnkey evaluates this condition when the position's key asks to sign a transaction. It is part of an
// ALLOW policy: if the condition is false, or errors, Turnkey refuses to sign.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { COMPUTE_BUDGET_BOUND } from "./compute-budget-bound";

// ── Public program ids and mints (well known, not Darwin-specific) ─────────────────────────────────────
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** dFlow's swap router (the strategy's primary venue). */
export const DFLOW_ROUTER = "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH";
/** Jupiter v6 aggregator (the fallback router when dFlow has no route). */
export const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/** The SPL Memo program id. No address lookup table can live at it, so `all(l, key in [it])` means "no tables". */
export const NEVER_A_TABLE_KEY = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * The dFlow router instructions the key may sign, by their 8-byte Anchor discriminator (hex). Every dFlow
 * instruction that takes a caller-chosen destination is absent, so a swap's output can only land in an
 * account derived from the signing wallet.
 */
export const DFLOW_ALLOWED_INSTRUCTIONS: readonly (readonly [name: string, discriminatorHex: string])[] = [
  ["swap", "f8c69e91e17587c8"],
  ["swap2", "414b3f4ceb5b5b88"],
  ["wrap_sol", "2f3e9bac83cd25c9"],
  ["unwrap_sol", "63280e692d6bacc9"],
  ["open_order", "ce58588f268832e0"],
  ["create_referral_token_account_idempotent", "2ee829905525aaaf"],
  ["init_market_ledger_idempotent", "b72b8b4f7de1239f"],
];
/** Associated Token Account program: `Create` (00) and `CreateIdempotent` (01) only — never `RecoverNested`. */
export const ATA_ALLOWED_INSTRUCTIONS: readonly string[] = ["00", "01"];
/** Jupiter v6 `shared_accounts_route` — the only Jupiter instruction admitted. */
export const JUPITER_SHARED_ACCOUNTS_ROUTE_DISC = "c1209b3341d69c81";
const JUPITER_SAR_ACCOUNTS = { userTransferAuthority: 2, destinationTokenAccount: 6, platformFeeAccount: 9 } as const;
/** The largest rent payback (lamports) a swap may send to Darwin's fee-paying relay: one token account's rent. */
export const AGENT_RENT_PAYBACK_MAX_LAMPORTS = 1_488_440n;

/** Programs a dFlow-routed swap transaction may contain at all (sorted, as rendered). */
export const DFLOW_BRANCH_PROGRAMS = [SYSTEM_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, DFLOW_ROUTER, SPL_TOKEN_PROGRAM].sort();
/** Programs a Jupiter-routed swap transaction may contain at all (sorted, as rendered). */
export const JUPITER_BRANCH_PROGRAMS = [COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, JUPITER_V6_PROGRAM].sort();

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const quoted = (xs: readonly string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;

function assertAddress(value: string, label: string): string {
  if (!SOLANA_ADDRESS.test(value)) throw new Error(`${label}: '${value}' is not a Solana address`);
  new PublicKey(value); // throws on an off-curve / malformed key string
  return value;
}

/** The strategy wallet's canonical wrapped-SOL token account (classic Token program). */
export function agentWsolAta(agentWallet: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), new PublicKey(agentWallet), true, new PublicKey(SPL_TOKEN_PROGRAM)).toBase58();
}

/** The dFlow branch's venue predicate (upstream `turnkeyAllowConditionFor("spot", …)` at v9). */
export function dflowVenuePredicate(agentWallet: string, darwinRelayWallet: string): string {
  const wsolAta = agentWsolAta(agentWallet);
  const relay = darwinRelayWallet;
  const dflowDiscs = quoted(DFLOW_ALLOWED_INSTRUCTIONS.map(([, hex]) => hex));
  const sys = `solana.tx.instructions.filter(i, i.program_key == '${SYSTEM_PROGRAM}')`;
  return [
    // Every top-level instruction is one of these programs.
    `solana.tx.instructions.all(i, i.program_key in ${quoted(DFLOW_BRANCH_PROGRAMS)})`,
    // Witness: at least one allowed dFlow instruction is present.
    `solana.tx.instructions.any(i, i.program_key == '${DFLOW_ROUTER}' && i.instruction_data_hex[0..16] in ${dflowDiscs})`,
    // Every ATA instruction is a create; every dFlow instruction is an allowed one.
    `solana.tx.instructions.filter(i, i.program_key == '${ATA_PROGRAM}').all(j, j.instruction_data_hex in ${quoted(ATA_ALLOWED_INSTRUCTIONS)})`,
    `solana.tx.instructions.filter(i, i.program_key == '${DFLOW_ROUTER}').all(j, j.instruction_data_hex[0..16] in ${dflowDiscs})`,
    // Relay rent payback: at most one System instruction, a plain Transfer, only from this wallet to Darwin's
    // fee-paying relay, below one token account's rent, and only beside the relay's own create of this
    // wallet's wSOL account (the rent being paid back).
    `${sys}.count() <= 1`,
    `${sys}.all(j, j.instruction_data_hex[0..8] == '02000000')`,
    `solana.tx.transfers.all(t, t.from == '${agentWallet}' && t.to == '${relay}' && t.amount < ${AGENT_RENT_PAYBACK_MAX_LAMPORTS + 1n})`,
    `(${sys}.count() == 0 || solana.tx.instructions.any(i, i.program_key == '${ATA_PROGRAM}' && i.instruction_data_hex in ['00', '01'] && i.accounts.count() > 2 && i.accounts[0].account_key == '${relay}' && i.accounts[1].account_key == '${wsolAta}' && i.accounts[2].account_key == '${agentWallet}'))`,
    // Token program: CloseAccount (09) only, three accounts, closing into this wallet or the relay, by this wallet.
    `solana.tx.instructions.filter(i, i.program_key == '${SPL_TOKEN_PROGRAM}').all(j, j.instruction_data_hex == '09' && j.accounts.count() == 3 && (j.accounts[1].account_key == '${agentWallet}' || j.accounts[1].account_key == '${relay}') && j.accounts[2].account_key == '${agentWallet}')`,
  ].join(" && ");
}

/** The Jupiter fallback branch (upstream `jupiterSpotBranchClauses` / `fallbackBranch("jupiter", …)`). */
export function jupiterBranch(agentWallet: string, darwinRelayWallet: string): string {
  const { userTransferAuthority: auth, destinationTokenAccount: dest, platformFeeAccount: fee } = JUPITER_SAR_ACCOUNTS;
  const clauses = [
    `solana.tx.instructions.any(i, i.program_key == '${JUPITER_V6_PROGRAM}' && i.accounts.any(a, a.account_key == '${agentWallet}' && a.signer == true))`,
    `solana.tx.instructions.all(i, i.program_key in ${quoted(JUPITER_BRANCH_PROGRAMS)})`,
    `solana.tx.instructions.any(i, i.program_key == '${JUPITER_V6_PROGRAM}' && i.instruction_data_hex[0..16] == '${JUPITER_SHARED_ACCOUNTS_ROUTE_DISC}')`,
    `solana.tx.instructions.filter(i, i.program_key == '${JUPITER_V6_PROGRAM}').all(j, ` +
      `j.instruction_data_hex[0..16] == '${JUPITER_SHARED_ACCOUNTS_ROUTE_DISC}' && j.accounts.count() > ${fee} && ` +
      `j.accounts[${auth}].account_key == '${agentWallet}' && ` +
      `j.accounts[${fee}].account_key == '${JUPITER_V6_PROGRAM}' && ` +
      `solana.tx.instructions.any(c, c.program_key == '${ATA_PROGRAM}' && c.accounts.count() > 2 && ` +
      `c.accounts[1].account_key == j.accounts[${dest}].account_key && c.accounts[2].account_key == '${agentWallet}'))`,
    `solana.tx.instructions.filter(i, i.program_key == '${ATA_PROGRAM}').count() <= 1`,
    `solana.tx.instructions.filter(i, i.program_key == '${ATA_PROGRAM}').all(j, ` +
      `j.instruction_data_hex in ['00', '01'] && j.accounts.count() > 2 && j.accounts[2].account_key == '${agentWallet}' && ` +
      `j.accounts[0].account_key in ['${agentWallet}', '${darwinRelayWallet}'])`,
    `solana.tx.address_table_lookups.all(l, l.address_table_key in ['${NEVER_A_TABLE_KEY}'])`,
  ];
  return `(${clauses.join(" && ")})`;
}

/**
 * The whole spot ALLOW condition for a wallet:
 *   kind is SIGN_TRANSACTION && Turnkey is signing WITH this wallet
 *   && ( dFlow swap signed by this wallet || Jupiter swap signed by this wallet )
 *   && the compute-budget (priority fee) bound.
 */
export function spotAllowCondition(agentWallet: string, darwinRelayWallet: string): string {
  assertAddress(agentWallet, "strategy wallet");
  assertAddress(darwinRelayWallet, "Darwin relay wallet");
  const head = [`activity.kind == 'SIGN_TRANSACTION'`, `wallet_account.address == '${agentWallet}'`];
  const walletSigns = `solana.tx.instructions.any(i, i.program_key == '${DFLOW_ROUTER}' && i.accounts.any(a, a.account_key == '${agentWallet}' && a.signer == true))`;
  const dflowBranch = `(${[walletSigns, dflowVenuePredicate(agentWallet, darwinRelayWallet)].join(" && ")})`;
  const branches = [dflowBranch, jupiterBranch(agentWallet, darwinRelayWallet)];
  return [...head, `(${branches.join(" || ")})`, COMPUTE_BUDGET_BOUND].join(" && ");
}
