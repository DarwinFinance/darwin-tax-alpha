# Changes from upstream

Every published file is either **generated** from production code by `scripts/sync.ts`, or **hand-ported**.
This file lists every difference from production. The production commit is in `UPSTREAM.json`.

## Applies to every generated file

- **Comments are stripped.** Production comments reference internal systems, incidents and tooling. Code is
  re-printed by the TypeScript printer, which also normalizes formatting (indentation, line breaks, numeric
  separators such as `1_000_000` → `1000000`). String and template literals are kept exactly, which is what
  the byte-exact policy text depends on.
- **Imports are rewritten** to this repository's layout (`@/lib/tax/holding-period` → `./holding-period`, and
  so on; tests: `vitest` → `bun:test`). See the `imports` maps in `scripts/sync-manifest.ts`.

## Generated whole modules (no other change)

| Published | Production |
|-----------|------------|
| `src/rules/planner.ts` | `src/lib/strategy/planner.ts` |
| `src/rules/impact-split.ts` | `src/lib/strategy/impact-split.ts` |
| `src/rules/exit-planner.ts` | `src/lib/strategy/exit-planner.ts` |
| `src/rules/sol-position.ts` | `src/lib/strategy/sol-position.ts` |
| `src/rules/minimums.ts` | `src/lib/strategy/minimums.ts` |
| `src/rules/holding-period.ts` | `src/lib/tax/holding-period.ts` |
| `src/rules/wash-window.ts` | `src/lib/tax/wash-window.ts` |
| `src/permissions/self-address-allowlist.ts` | `src/lib/turnkey/self-address-allowlist.ts` |

## Generated from named declarations of mixed modules

These production modules also load data from the database or the network. Only the named pure declarations
are copied, unchanged, below a small fixed header.

| Published | Production declarations | Header / edits |
|-----------|-------------------------|----------------|
| `src/rules/engine-rules.ts` | `strategy/engine.ts`: `DEFAULT_CONFIG`, `applyMarketCapWeights`, `IDLE_CASH_DEPLOY_USD`, `DEPLOY_COOLDOWN_SECS`, `buildWashBlock`, `shouldDeployIdleCash`, `hasFreshAuthorizedCryptoDeposit` | `export` added to `DEFAULT_CONFIG`, `IDLE_CASH_DEPLOY_USD`, `DEPLOY_COOLDOWN_SECS` (module-private upstream). |
| `src/rules/exit-rules.ts` | `strategy/exit-engine.ts`: `EXIT_PRICE_WAIT_MAX_SECS`, `reconcileLotsToChainQty`, `decideUsdcResidual` | — |
| `src/rules/withdraw-rules.ts` | `strategy/withdraw-engine.ts`: `withdrawSalesReadyForSweep`, `supportsPendingWithdraw`, `partialWithdrawAtoms`, `planPartialSaleAtoms`, `withdrawTransfersConfirmed`, `planPartialInKindTransfers`, `WithdrawLeg` | Header defines `nanoid` as `crypto.randomUUID()` (upstream imports an id helper; it only supplies the default leg id). `export` added to `WithdrawLeg`. |
| `src/rules/harvest-records.ts` | `strategy/finalizer.ts`: `HarvestInput`; `strategy/executor-wiring.ts`: `assetPlaceholder`, `buildHarvestInputs` | Header declares `ExecutorLeg` as the four fields these functions read (upstream: the full executor row type). Nothing else from `executor-wiring.ts` is published. |
| `src/rules/same-security.ts` | `tax/wash-sale.ts`: `SameSecurityFn`; `tax/position-rollup.ts`: `SameSecurityGroupRow`, `buildSameSecurityFn` | — |
| `src/rules/wash-eligibility.ts` | `equity-financials/is-xstock.ts`: `isXStockId`, `isOndoTokenizedStockId`, `isTokenizedEquityId`; `tax/wash-sale.ts`: `WashEligibleFn`, `isTokenizedEquityWashEligible`, `buildWashEligibleFn` | — |
| `src/permissions/compute-budget-bound.ts` | `agent/compute-budget-bound.ts`: the policy text (`COMPUTE_BUDGET_BOUND` and its two parts) and `BOUNDED_MAX_CU_PRICE_MICROLAMPORTS` | The executor-side helpers in the same module (transaction inspection and price capping) are not published. |
| `src/permissions/policy-text.ts` | `turnkey/policy-templates.ts`: `activityKindIn`, `assertSafeToken` | — |
| `src/permissions/strategy-deny.ts` | `agent/agent-deny-policy.ts`: `AGENT_DENY_CONDITION`; `strategy/custody/setup.ts`: `strategyObjectNames`, `strategyUserConsensus`, `buildStrategyDenyPolicyBody` | — |

## Hand-ported

The production declarations each hand port mirrors are pinned by hash in `UPSTREAM.json`; the sync fails when
one changes.

### `src/permissions/agent-spot-allow.ts`
Production renders the spot ALLOW for every venue and every historical policy generation from one registry
(`agent/allow-condition.ts`, `agent/venue-registry.ts`, `agent/relay-rent-payback-policy.ts`,
`agent/agent-close-policy.ts`, `agent/router-fallback-policy.ts`, `agent/dflow-account-bounds.ts`). This file
renders only the five generations a Tax Alpha position can carry:
- `v13-jupiter-only` (current): no dFlow branch. `SIGN && signer-bound && (Jupiter-only branch) && compute-budget
  bound`, where the branch (`jupiterOnlyBranchClauses`, upstream `jupiterOnlySpotClauses`) admits only
  `shared_accounts_route` with [2] the wallet, [9] the Jupiter program (none), the wallet exactly once in the
  instruction, and [6] an in-transaction ATA create owned by the wallet; at most two ATA creates, owned by the
  wallet and paid by the wallet or the relay; System only a Transfer from the wallet to its own wSOL account; SPL
  Token only SyncNative / CloseAccount of that account, closes into the wallet; no lookup tables.
- `v12-dflow-names-narrowed` (superseded): v11 with the dFlow discriminator lists naming only swap, swap2,
  wrap_sol and unwrap_sol (`DFLOW_NAMES_DROPPED_AT_V12`, `dflowInstructionsFor`).
- `v11-dflow-accounts-bound` (superseded): v10 plus, inside the dFlow branch, every ATA instruction's owner is the
  wallet and its payer the wallet or the relay, and every dFlow `wrap_sol` deposits into the wallet's own wSOL account.
- `v10-relay-close-bound` (superseded): the payback rides only the relay's non-idempotent create, and a close to
  the relay must be of a fresh, relay-created, non-wSOL account.
- `v9-priority-fee-bound` (superseded).

The four older ones are rendered so the verifier can recognise an older position. Program sets and instruction
discriminators are written out as named constants. **Darwin's relay wallet is a parameter** (`darwinRelayWallet`,
also passed to `dflowAtaCreatesOwnedClause` and `jupiterOnlyBranchClauses`); production pins it as a constant. The
output is byte-identical to production for all five generations (checked by `scripts/sync.ts` and by the test
vectors).

### `src/permissions/strategy-allow.ts`
Production: `strategy/custody/strategy-allow.ts`.
- `strategySwapClause(strategyWallet, darwinRelayWallet, generation)` takes the relay as a parameter and calls
  `spotAllowCondition` above instead of the production registry. `s5-jupiter-only` (current) is agent v13 alone
  (`strategyGenerationIsJupiterOnly`; no `strategyClosesToSelfClause`, since v13's own Token bound is narrower);
  `s4-dflow-names-narrowed`, `s3-dflow-accounts-bound` and `s2-relay-close-bound` (superseded) are agent v12, v11
  and v10 `&&` `strategyClosesToSelfClause`; `s1-agent-v9-swap` (superseded) is agent v9.
- `StrategyAllowArgs` gains `darwinRelayWallet`.
- Production computes the position's USDC token account and passes it to the registry, which ignores it for
  these generations; that unused computation is dropped.
- Not published: `strategyAllowGenerationOf`, `upgradedStrategyAllowCondition`,
  `strategyAllowConditionAtGeneration`, `intermediateStrategyAllowGenerations` and
  `authoredStrategyAllowsForSetup`, which read an installed policy or Darwin's own setup records to plan and
  clean up the security update (including re-rendering every later generation's ALLOW, `-s2` to `-s5`, for a
  position whose update stopped half-way). The verifier renders every generation from the position's
  parameters instead; the security update carries the redemption alternatives over byte for byte, so the
  result is the same text.
- Everything else (generations, the closes-to-self clause, the two redemption clauses, validation, names
  including the security updates' `-s2` to `-s5` names, notes, consensus) is the production code. The notes
  string still says "dFlow swaps"; it is production's text, unchanged, and is not part of what Turnkey enforces.

### `src/permissions/position.ts` (new)
Parameter validation; `expectedPositionPolicies`, which renders both policies for one position at the current
generation (s5); `supersededAllowPolicy(params, generation)`, which renders the s1, s2, s3 or s4 ALLOW;
`SUPERSEDED_GENERATIONS`; and `acceptedAllowPolicyNames`. Not in production.

### `src/verify/fetch.ts` (new)
The verifier's optional `--fetch`: one stamped `list_policies` query to `api.turnkey.com` with the user's own
API key. Not in production (Darwin's browser code uses Turnkey's SDK).

### `src/rules/in-kind-contribution.ts`
Production: `strategy/in-kind-contribution.ts` `reviewInKindContribution`, which interleaves its decisions with
database reads. Published as `reviewInKindContributionFacts`, taking the facts as input instead:
- Same checks, same order, same refusal codes and messages, same lot ordering and election.
- Not reproduced: the enrollment ownership / status / funding-wallet check, and the loading of tax books and
  lots (server concerns; the loaded lots arrive as `openLots` and `availableQtyById`).
- The source-wallet check compares an internal wallet-source tag upstream; here it is the boolean
  `isUserHostedWallet`.

### `src/rules/rounding.ts`
Production: `packages/domain/src/rounding.ts` `truncTo`, `stripFloatNoise`. The rules here only call
`truncTo(x)` with 0 decimal places; that path is copied exactly. The decimal-places path depends on a shared
number-formatting engine that is not published, so `truncTo(x, dp)` with `dp > 0` throws here.

## Tests

- `test/upstream/*.test.ts` are production's unit tests, generated (comments stripped, imports rewritten).
- `test/permissions.test.ts` is adapted from production's `strategy-allow.test.ts` (its comparison against the
  production registry is replaced by the byte-exact vectors), plus v9 to v13 and s1 to s5 differences, DENY
  and parameter tests.
- `test/rules-extra.test.ts`, `test/verify.test.ts` and `test/cli.test.ts` are new.

## Not published (by design)

Server-side pre-sign guards and instruction filters, signing and execution pipelines, relay / fee-payer
logic, kill switches and breakers, MFA / 2FA / recovery / session design, schedules and monitoring, the
enrollment ceremony, and any account-specific identifier.
