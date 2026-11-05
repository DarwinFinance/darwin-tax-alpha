/**
 * What this repository publishes, and where each file comes from in the private monorepo.
 *
 * Four kinds of entry:
 *   file   a whole upstream module, comments stripped, imports rewritten through `imports`.
 *   decls  named top-level declarations lifted out of one or more upstream modules (comments stripped),
 *          below a fixed `header`. Used where an upstream module mixes pure rules with database or
 *          network code: only the named pure declarations are copied.
 *   test   an upstream unit test, comments stripped, `vitest` → `bun:test`, imports rewritten.
 *   hand   written by hand for this repository (see CHANGES-FROM-UPSTREAM.md). `pins` names the upstream
 *          declarations it mirrors; sync.ts records their hashes and fails when one changes upstream, so
 *          a human re-checks the hand port.
 *
 * Anything not listed here (or in STATIC_FILES) must not exist in the repository: sync.ts fails if it does.
 */

export type Source = { upstream: string; decls: string[]; export?: string[] };
export type Pin = { upstream: string; decls: string[] };

export type Entry =
  | { kind: "file"; out: string; upstream: string; imports?: Record<string, string> }
  | { kind: "decls"; out: string; header: string; sources: Source[] }
  | { kind: "test"; out: string; upstream: string; imports?: Record<string, string> }
  | { kind: "hand"; out: string; pins: Pin[] };

const S = "src/lib/strategy";
const T = "src/lib/tax";
const A = "src/lib/agent";

export const MANIFEST: Entry[] = [
  // ── Strategy rules ───────────────────────────────────────────────────────────────────────────────
  { kind: "file", out: "src/rules/planner.ts", upstream: `${S}/planner.ts`, imports: { "@/lib/tax/holding-period": "./holding-period", "./sol-position": "./sol-position" } },
  { kind: "file", out: "src/rules/impact-split.ts", upstream: `${S}/impact-split.ts`, imports: { "@/lib/rounding": "./rounding", "./planner": "./planner" } },
  { kind: "file", out: "src/rules/exit-planner.ts", upstream: `${S}/exit-planner.ts` },
  { kind: "file", out: "src/rules/sol-position.ts", upstream: `${S}/sol-position.ts` },
  { kind: "file", out: "src/rules/minimums.ts", upstream: `${S}/minimums.ts` },
  { kind: "file", out: "src/rules/holding-period.ts", upstream: `${T}/holding-period.ts` },
  { kind: "file", out: "src/rules/wash-window.ts", upstream: `${T}/wash-window.ts` },
  {
    kind: "decls", out: "src/rules/same-security.ts", header: "",
    sources: [
      { upstream: `${T}/wash-sale.ts`, decls: ["SameSecurityFn"] },
      { upstream: `${T}/position-rollup.ts`, decls: ["SameSecurityGroupRow", "buildSameSecurityFn"] },
    ],
  },
  {
    kind: "decls", out: "src/rules/wash-eligibility.ts", header: "",
    sources: [
      { upstream: "src/lib/equity-financials/is-xstock.ts", decls: ["isXStockId", "isOndoTokenizedStockId", "isTokenizedEquityId"] },
      { upstream: `${T}/wash-sale.ts`, decls: ["WashEligibleFn", "isTokenizedEquityWashEligible", "buildWashEligibleFn"] },
    ],
  },
  {
    kind: "decls", out: "src/rules/engine-rules.ts",
    header: [
      `import { MIN_STRATEGY_SWAP_USD } from "./minimums";`,
      `import type { IndexMember } from "./planner";`,
      `import { buildSameSecurityFn, type SameSecurityGroupRow } from "./same-security";`,
    ].join("\n"),
    sources: [{
      upstream: `${S}/engine.ts`,
      decls: ["DEFAULT_CONFIG", "applyMarketCapWeights", "IDLE_CASH_DEPLOY_USD", "DEPLOY_COOLDOWN_SECS", "buildWashBlock", "shouldDeployIdleCash", "hasFreshAuthorizedCryptoDeposit"],
      export: ["DEFAULT_CONFIG", "IDLE_CASH_DEPLOY_USD", "DEPLOY_COOLDOWN_SECS"],
    }],
  },
  {
    kind: "decls", out: "src/rules/exit-rules.ts",
    header: `import type { ExitLot } from "./exit-planner";`,
    sources: [{ upstream: `${S}/exit-engine.ts`, decls: ["EXIT_PRICE_WAIT_MAX_SECS", "reconcileLotsToChainQty", "decideUsdcResidual"] }],
  },
  {
    kind: "decls", out: "src/rules/withdraw-rules.ts",
    header: [
      `import { truncTo } from "./rounding";`,
      `import { solTransferAtoms, splitSolSale, type SolPositionParts } from "./sol-position";`,
      `const nanoid = (): string => crypto.randomUUID();`,
    ].join("\n"),
    sources: [{
      upstream: `${S}/withdraw-engine.ts`,
      decls: ["withdrawSalesReadyForSweep", "supportsPendingWithdraw", "partialWithdrawAtoms", "planPartialSaleAtoms", "withdrawTransfersConfirmed", "planPartialInKindTransfers", "WithdrawLeg"],
      export: ["WithdrawLeg"],
    }],
  },
  {
    kind: "decls", out: "src/rules/harvest-records.ts",
    header: [
      `import type { WashEligibleFn } from "./wash-eligibility";`,
      `import { washWindowClearsAtSecs } from "./wash-window";`,
      `export interface ExecutorLeg { id: string; inMint: string | null; outMint: string | null; harvestLots: unknown }`,
    ].join("\n"),
    sources: [
      { upstream: `${S}/finalizer.ts`, decls: ["HarvestInput"] },
      { upstream: `${S}/executor-wiring.ts`, decls: ["assetPlaceholder", "buildHarvestInputs"] },
    ],
  },
  { kind: "hand", out: "src/rules/rounding.ts", pins: [{ upstream: "packages/domain/src/rounding.ts", decls: ["truncTo", "stripFloatNoise"] }] },
  { kind: "hand", out: "src/rules/in-kind-contribution.ts", pins: [{ upstream: `${S}/in-kind-contribution.ts`, decls: ["USDC_MINT_ADDRESS", "InKindLotElection", "MAX_REVIEWED_LOTS", "reviewInKindContribution"] }] },

  // ── Permission templates ─────────────────────────────────────────────────────────────────────────
  {
    kind: "decls", out: "src/permissions/compute-budget-bound.ts", header: "",
    sources: [{ upstream: `${A}/compute-budget-bound.ts`, decls: ["COMPUTE_BUDGET", "KINDS_ONLY_LIMIT_OR_PRICE", "PRICE_UNDER_2_16", "COMPUTE_BUDGET_BOUND", "BOUNDED_MAX_CU_PRICE_MICROLAMPORTS"] }],
  },
  {
    kind: "decls", out: "src/permissions/policy-text.ts", header: "",
    sources: [{ upstream: "src/lib/turnkey/policy-templates.ts", decls: ["activityKindIn", "assertSafeToken"] }],
  },
  {
    kind: "decls", out: "src/permissions/strategy-deny.ts",
    header: `import { assertSafeToken } from "./policy-text";`,
    sources: [
      { upstream: `${A}/agent-deny-policy.ts`, decls: ["AGENT_DENY_CONDITION"] },
      { upstream: `${S}/custody/setup.ts`, decls: ["strategyObjectNames", "strategyUserConsensus", "buildStrategyDenyPolicyBody"] },
    ],
  },
  { kind: "file", out: "src/permissions/self-address-allowlist.ts", upstream: "src/lib/turnkey/self-address-allowlist.ts" },
  {
    kind: "hand", out: "src/permissions/agent-spot-allow.ts",
    pins: [
      { upstream: `${A}/allow-condition.ts`, decls: ["SIGN_TRANSACTION_KIND", "walletBinding", "SOLANA_ADDRESS", "signerBinding", "buildAgentAllowCondition"] },
      {
        upstream: `${A}/venue-registry.ts`,
        decls: [
          "CURRENT_ALLOW_SHAPE", "turnkeyAllowConditionFor", "instructionPredicate", "boundPrograms", "programsFor",
          "shapeBindsSigningWallet", "shapeAdmitsFallbackRouters", "shapeBoundsPriorityFee", "shapeBoundsRelayCloses",
          "shapeAllowsRentPayback", "shapeAllowsAgentCloses", "shapeAllowsExistingPayback", "shapeBindsDflowAccounts",
          "shapeIsJupiterOnly", "DFLOW_NAMES_DROPPED_AT_V12", "shapeNarrowsDflowNames", "shapeNamesFor",
        ],
      },
      { upstream: `${A}/dflow-account-bounds.ts`, decls: ["ATA_PROGRAM", "DFLOW_ROUTER", "DFLOW_WRAP_SOL_DISC", "SOLANA_ADDRESS", "assertAddress", "dflowAtaCreatesOwnedClause", "dflowWrapSolTargetClause"] },
      { upstream: `${A}/relay-rent-payback-policy.ts`, decls: ["AGENT_RENT_PAYBACK_MAX_LAMPORTS", "agentWsolAta", "relayRentPaybackClauses"] },
      { upstream: `${A}/agent-close-policy.ts`, decls: ["agentTokenCloseClause", "agentRelayCloseBoundClause"] },
      { upstream: `${A}/router-fallback-policy.ts`, decls: ["JUPITER_SAR_ACCOUNTS", "V8_FALLBACK_ROUTERS", "AGENT_JUPITER_TRADE_PROGRAMS", "jupiterSpotBranchClauses", "fallbackBranch", "AGENT_JUPITER_V13_TRADE_PROGRAMS", "jupiterOnlySpotClauses"] },
    ],
  },
  {
    kind: "hand", out: "src/permissions/strategy-allow.ts",
    pins: [{
      upstream: `${S}/custody/strategy-allow.ts`,
      decls: [
        "NO_LOOKUP_TABLES", "validate", "StrategyAllowGeneration", "ALL_STRATEGY_ALLOW_GENERATIONS", "CURRENT_STRATEGY_ALLOW_GENERATION",
        "strategyGenerationIsJupiterOnly", "AGENT_SHAPE_FOR", "strategyClosesToSelfClause", "strategySwapClause", "strategyTokenRedeemClause", "strategySolRedeemClause",
        "strategyAllowCondition", "STRATEGY_ALLOW_NOTES", "STRATEGY_ALLOW_NOTES_BEFORE_S5", "strategyAllowNotesFor", "strategyAllowPolicyName", "strategyAllowUpgradePolicyName",
        "strategyAllowGenerationPolicyName", "generationPolicyName", "strategyAllowPolicyNames", "buildStrategyAllowPolicyBody",
      ],
    }],
  },

  // ── Upstream unit tests ──────────────────────────────────────────────────────────────────────────
  { kind: "test", out: "test/upstream/planner.test.ts", upstream: `${S}/planner.test.ts`, imports: { "./planner": "../../src/rules/planner" } },
  { kind: "test", out: "test/upstream/impact-split.test.ts", upstream: `${S}/impact-split.test.ts`, imports: { "./planner": "../../src/rules/planner", "./impact-split": "../../src/rules/impact-split" } },
  { kind: "test", out: "test/upstream/exit-planner.test.ts", upstream: `${S}/exit-planner.test.ts`, imports: { "./exit-planner": "../../src/rules/exit-planner" } },
  { kind: "test", out: "test/upstream/minimums.test.ts", upstream: `${S}/minimums.test.ts`, imports: { "./minimums": "../../src/rules/minimums" } },
  { kind: "test", out: "test/upstream/holding-period.test.ts", upstream: `${T}/holding-period.test.ts`, imports: { "./holding-period": "../../src/rules/holding-period" } },
  { kind: "test", out: "test/upstream/engine.test.ts", upstream: `${S}/engine.test.ts`, imports: { "./engine": "../../src/rules/engine-rules", "@/lib/tax/position-rollup": "../../src/rules/same-security" } },
  { kind: "test", out: "test/upstream/market-cap-weights.test.ts", upstream: `${S}/market-cap-weights.test.ts`, imports: { "./engine": "../../src/rules/engine-rules" } },
  { kind: "test", out: "test/upstream/deploy-idle-cash.test.ts", upstream: `${S}/deploy-idle-cash.test.ts`, imports: { "./engine": "../../src/rules/engine-rules" } },
  { kind: "test", out: "test/upstream/withdraw-engine.test.ts", upstream: `${S}/withdraw-engine.test.ts`, imports: { "./withdraw-engine": "../../src/rules/withdraw-rules" } },
  {
    kind: "test", out: "test/upstream/build-harvest-inputs.test.ts", upstream: `${S}/build-harvest-inputs.test.ts`,
    imports: { "./executor-wiring": "../../src/rules/harvest-records", "@/lib/tax/wash-sale": "../../src/rules/wash-eligibility", "./executor": "../../src/rules/harvest-records" },
  },
];

/** Files that are not generated and carry no upstream code. Everything else in the repo must be in MANIFEST. */
export const STATIC_FILES = [
  ".gitignore", ".gitleaks.toml", "LICENSE", "README.md", "SECURITY.md", "CHANGES-FROM-UPSTREAM.md", "UPSTREAM.json",
  "package.json", "bun.lock", "tsconfig.json",
  "scripts/sync.ts", "scripts/sync-manifest.ts", "scripts/sync-from-upstream.md", "scripts/scan.ts",
  "src/rules/index.ts", "src/permissions/index.ts", "src/permissions/position.ts",
  "src/verify/index.ts", "src/verify/verify.ts", "src/verify/cli.ts", "src/verify/export.ts", "src/verify/fetch.ts",
  "src/verify/key-file.ts",
  "test/permissions.test.ts", "test/verify.test.ts", "test/rules-extra.test.ts", "test/cli.test.ts", "test/key-file.test.ts",
  "test/vectors/position-a.params.json", "test/vectors/position-a.expected.json", "test/vectors/position-a.export.json",
  "test/vectors/position-b.params.json", "test/vectors/position-b.expected.json", "test/vectors/position-b.export.json",
  "test/vectors/position-c.params.json", "test/vectors/position-c.expected.json", "test/vectors/position-c.export.json",
  "test/vectors/position-d.params.json", "test/vectors/position-d.expected.json", "test/vectors/position-d.export.json",
  "test/vectors/position-e.params.json", "test/vectors/position-e.expected.json", "test/vectors/position-e.export.json",
  "test/vectors/README.md",
];

/**
 * Upstream modules that must never be a source for this repository (server-side pre-sign guards, signing
 * pipelines, relay / fee-payer logic, kill switches, MFA / recovery / session design, monitoring). A
 * MANIFEST entry whose upstream path contains one of these fails the sync. (`executor-wiring.ts` is NOT
 * here: one pure booking function, `buildHarvestInputs`, is lifted from it by name — nothing else.)
 */
export const EXCLUDED_UPSTREAM = [
  "instruction-policy", "guard", "signing", "signer/", "kill-switch", "breaker", "/gas/", "relay", "session",
  "recovery", "mfa", "cron", "monitor", "sentry", "effect-", "ledger-reconcile", "preflight",
];

export const ALLOWED_PACKAGES = ["@solana/web3.js", "@solana/spl-token", "bun:test", "typescript", "node:fs", "node:path", "node:crypto", "node:child_process"];
