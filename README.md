# Darwin Tax Alpha

The rules that decide what Darwin's Tax Alpha strategy trades, the exact on-chain permissions each Tax Alpha
position installs in your own Turnkey account, and a verifier you can run to check that the permissions
installed for your position are exactly these.

> **This is a read-only mirror.** The code here is generated from Darwin's production code (a private
> repository) by `scripts/sync.ts`. `UPSTREAM.json` records the production commit it came from. Changes are
> made upstream and mirrored here; pull requests against this repository cannot change what runs in
> production. `CHANGES-FROM-UPSTREAM.md` lists every place the code here differs from production and why.

- [What Tax Alpha does](#what-tax-alpha-does)
- [The strategy rules](#the-strategy-rules)
- [What a position's key can and cannot do](#what-a-positions-key-can-and-cannot-do)
- [Verify your position](#verify-your-position)
- [Repository layout and development](#repository-layout-and-development)

## What Tax Alpha does

Tax Alpha is tax-loss harvesting for crypto. Each Tax Alpha position is a separate Solana wallet that holds
either one crypto asset or a market-cap-weighted basket.

- **You fund it** with USD (USDC), which the strategy uses to buy the asset or basket, or **in kind**, by
  moving tokens you already hold into the position. An in-kind contribution keeps your tax lots: their cost
  basis and acquisition dates move with them.
- **It harvests losses.** When a tax lot is trading at least **1% below its cost basis** and selling the
  asset would realize at least **$1 of losses**, the strategy sells it and buys the same asset back. You keep
  your exposure and realize a loss you can use on your taxes. Under US tax law, crypto is not "stock or
  securities", so the 30-day wash-sale rule (IRC §1091) does not apply to it; tokenized equities are treated
  as securities and are subject to the wash-sale window.
- **It never sells a lot at a gain** to rebalance. Spare cash buys the most underweight assets.
- **It limits market impact.** Any swap whose route would move the price by more than **5 basis points
  (0.05%)** is split into smaller swaps that each stay within that bound.
- **You can redeem** in USD (the position's assets are sold, which is taxable) or in kind (the assets are
  transferred to your own wallet, which is not a sale).

## The strategy rules

All of these are pure functions: no network, no database. They take holdings, prices and settings and return
a decision. Production wraps them with data loading, signing and execution, which is not published here.

| Rule | Where | Notes |
|------|-------|-------|
| Harvest eligibility, lot ranking, rebuy, cash deployment | `src/rules/planner.ts` (`buildTradePlan`) | 1%-below-basis trigger (`minLossPct`, default 0.01); $1 minimum loss per crypto sale (`minCryptoHarvestLossUsd`); lots ranked by after-tax benefit; crypto harvests rebuy the same asset with the proceeds; never realizes a gain. |
| Production planner settings | `src/rules/engine-rules.ts` (`DEFAULT_CONFIG`) | Turnover cap, execution-cost estimate, drift threshold. |
| Market-cap weights | `src/rules/engine-rules.ts` (`applyMarketCapWeights`) | Basket weights from market caps; an asset without a market cap gets weight 0. |
| Wash-sale block (securities) | `src/rules/engine-rules.ts` (`buildWashBlock`), `src/rules/wash-window.ts`, `src/rules/wash-eligibility.ts`, `src/rules/same-security.ts` | A harvested security (and anything substantially identical to it) is not bought back until its 30-day window clears. Crypto is never wash-blocked. |
| Wash window stamped on each harvest | `src/rules/harvest-records.ts` (`buildHarvestInputs`) | Per-lot realized loss from the actual fill; the window runs from the fill time. |
| Short-term vs long-term | `src/rules/holding-period.ts` | The calendar rule: held more than one year. |
| 5 bps price-impact split | `src/rules/impact-split.ts` | `STRATEGY_MAX_IMPACT_BPS = 5`, `STRATEGY_SLIPPAGE_BPS = 5`; a sale splits along its tax lots; no piece under $10; redemptions may wait up to 24 hours for impact to come back under the bound. |
| When idle cash is deployed | `src/rules/engine-rules.ts` (`shouldDeployIdleCash`, `hasFreshAuthorizedCryptoDeposit`) | |
| Exits (full redemption) | `src/rules/exit-planner.ts`, `src/rules/exit-rules.ts` | Sell everything to USDC, or transfer everything in kind; lots reconciled to the on-chain quantity keeping the highest-basis lots. |
| Partial redemptions | `src/rules/withdraw-rules.ts` | The requested fraction of every holding, in exact on-chain units, for both cash and in-kind redemptions. |
| SOL handling | `src/rules/sol-position.ts` | A small native-SOL buffer for fees and rent is never sold or transferred by a plan. |
| In-kind contributions | `src/rules/in-kind-contribution.ts` | Single-asset strategies only; never USDC; lots chosen by your disposal method (FIFO / LIFO / highest basis) or your own selection; a lot without a recorded basis is refused rather than guessed. |
| Minimums | `src/rules/minimums.ts` | $5 minimum for single-asset strategies. |

Comments in the production code are stripped from the generated files (they reference internal systems);
this README and the tests document the behavior instead. `test/upstream/` holds production's own unit tests
for these rules, run unchanged apart from import paths.

## What a position's key can and cannot do

Darwin trades for your position with a dedicated key. The key belongs to a separate, **non-root** user in your
own Turnkey sub-organization: one user and one wallet per position. Turnkey holds the wallet's private key in
secure hardware and signs only what that user's policies allow. When you open a position, **your passkey**
installs two policies for it, and they are never edited afterwards:

- an **ALLOW** policy (`src/permissions/strategy-allow.ts`) listing the only transactions the key may have
  Turnkey sign, and
- a **DENY** policy (`src/permissions/strategy-deny.ts`) blocking everything a key could use to widen its own
  access.

These are enforced by Turnkey, not by Darwin's servers: a request from the position's key that does not match
is refused by Turnkey even if it comes from Darwin.

**The key can have Turnkey sign:**

1. **A swap inside the position's own wallet** — through dFlow's router, or Jupiter's v6 router as a
   fallback, signed with the position's wallet, using only an allow-list of swap instructions. dFlow's
   instructions that take a caller-chosen destination are excluded, so a swap's output lands in an account
   derived from the position's wallet. Darwin pays network fees through a fee-paying relay wallet, and a
   swap may also:
   - pay that relay back the rent of one temporary wrapped-SOL account it created in the same transaction
     (at most 1,488,440 lamports, about 0.0015 SOL), and
   - close one of the position wallet's token accounts, sending the account's balance of lamports to the
     position wallet or to the relay.
2. **A token redemption to you** — an SPL `TransferChecked` from the position's wallet into one of *your*
   wallets' token accounts, for the redemption mints listed when the position was opened. It may also
   create that token account for you.
3. **A SOL redemption to you** — a System `Transfer` from the position's wallet to one of *your* wallets,
   optionally after unwrapping the position's own wrapped SOL into itself.

Every one of these also caps the priority fee (at most 65,535 micro-lamports per compute unit, about 0.00009
SOL per transaction at the network's compute ceiling), so a permitted transaction cannot be used to burn the
position's SOL in fees. Both redemptions are refused if they use address lookup tables, which would hide
accounts from the checks.

**The key cannot:**

- send tokens or SOL to anyone except your listed wallets (with the exception of the relay payments in item 1);
- approve a delegate, change an account's authority, or use any program outside the lists above;
- sign arbitrary messages or raw payloads, or use Turnkey's send-transaction API;
- add, remove or change API keys, passkeys or any other credential, its own included;
- change MFA policies;
- otherwise act in your sub-organization. In Turnkey's policy model a non-root user needs a policy for every
  activity; the one default exception, a user managing its own credentials, is what the DENY closes.

**Read precisely.** The ALLOW's text is the guarantee; the sentences above summarize it. Three details matter:

- In the swap alternative, the close-account permission does not say *which* of the position wallet's token
  accounts may be closed. Closing a normal token account requires it to be empty (only its rent moves), but
  closing a wrapped-SOL account pays out its whole SOL balance. At the Turnkey layer, wrapped SOL held in
  the position's token accounts could therefore be paid to Darwin's relay wallet. Darwin's own signing
  service refuses that shape before it asks Turnkey, but that check is not part of what Turnkey enforces.
- The redemption alternatives bind every transfer to come *from* the position's wallet and go *to* your
  wallets, but do not fix which wallet Turnkey signs with. The key could ask Turnkey to sign a
  redemption-shaped transaction with another wallet of yours as the fee payer. No value can leave that
  wallet except the (capped) transaction fee and, for a token-account creation, rent that goes into your own
  new token account.
- Turnkey `ALLOW` policies add up: any *other* ALLOW naming the position's user would widen what the key may
  do. The verifier checks for that.

Program ids that appear in the policies are public: System `11111111111111111111111111111111`, SPL Token
`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`,
Associated Token Account `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, Compute Budget
`ComputeBudget111111111111111111111111111111`, dFlow router `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH`,
Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, and the Memo program
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (used as a key no lookup table can have). Mints: USDC
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, wrapped SOL `So11111111111111111111111111111111111111112`.

## Verify your position

The verifier renders the ALLOW and DENY your position should have from its parameters, then compares them
with the policies actually installed in your Turnkey sub-organization, byte for byte (effect, consensus and
condition). It also fails if any other ALLOW policy names the position's user, and warns about ALLOW policies
whose approvers are not pinned to specific users.

### 1. Write down the position's parameters

Create a JSON file with the values Darwin shows you for the position:

```json
{
  "strategyWallet": "<the position's wallet address>",
  "strategyUserId": "<the Turnkey user id of the position's signer>",
  "userWallets": ["<your wallet that redemptions pay>", "..."],
  "redemptionMints": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "<the strategy's asset mints>"],
  "darwinRelayWallet": "<Darwin's fee-paying relay wallet>",
  "enrollmentId": "<optional: the position id, only used to predict policy names>"
}
```

`darwinRelayWallet` is the same for every position; it is also the fee payer you can see on your position's
swap transactions in any Solana explorer.

### 2. Get your policy export from Turnkey

The export must come **straight from Turnkey**, fetched with **your own credential**, so you do not have to
trust Darwin's servers for it. It is the response of Turnkey's `list_policies` query for your
sub-organization:

```
POST https://api.turnkey.com/public/v1/query/list_policies
{ "organizationId": "<your sub-organization id>" }
```

- **Planned: a "Download my installed permissions" button in Darwin.** It will make this request from your
  browser directly to Turnkey's API, signed with your passkey, and save Turnkey's response unmodified. You
  can confirm in your browser's developer tools (Network tab) that the request goes to `api.turnkey.com`, not
  to Darwin.
- **With your own Turnkey API key.** If you hold an API key on your own sub-organization, send the request
  above with Turnkey's CLI or any Turnkey SDK (`getPolicies`) and save the JSON response.

Passkeys are bound to the website where they were created, so a passkey you created at Darwin can only sign
requests made from a Darwin page.

### 3. Run the verifier

```sh
bun install
bun src/verify/cli.ts --params position.json --export policies.json
```

```
PASS  ALLOW policy 'tax-alpha-allow-…' matches the expected text byte for byte (effect, consensus, condition)
PASS  DENY policy 'tax-alpha-deny-…' matches the expected text byte for byte (effect, consensus, condition)
PASS  no other ALLOW policy names this position's signer

RESULT: PASS — the installed permissions for this position are exactly the published templates.
```

Exit code 0 means pass, 1 means a mismatch (the output shows the first differing character), and 2 means
the input could not be read. `--json` prints a machine-readable result; `--print-expected` prints the
policies the parameters should produce. Try it on the examples in `test/vectors/`
(`position-a` passes; `position-b` has an extra redemption wallet and fails).

The verifier is also a library: `verifyPosition(params, parsePolicyExport(json))` from `src/verify`.

## Repository layout and development

```
src/rules/         strategy rules (pure functions)
src/permissions/   the ALLOW / DENY templates, rendered from a position's parameters
src/verify/        the verifier library and CLI
test/upstream/     production's unit tests for the published rules (generated)
test/              tests for the templates, the verifier and the hand-ported rules; test/vectors/ fixtures
scripts/           sync.ts regenerates the mirror from a production checkout (see sync-from-upstream.md)
```

```sh
bun install
bun test
bunx tsc --noEmit
```

Requires [Bun](https://bun.sh) 1.2 or later. Runtime dependencies: `@solana/web3.js` and `@solana/spl-token`
(for address derivation only — nothing here connects to a network).

Security issues: see [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
