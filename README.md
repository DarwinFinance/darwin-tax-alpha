# Darwin Tax Alpha

The rules that decide what Darwin's Tax Alpha strategy trades, the exact on-chain permissions each Tax Alpha
position installs in your own Turnkey account, and a verifier you can run to check that the permissions
installed for your position are exactly these.

> **This is a read-only mirror.** The code here is generated from Darwin's production code (a private
> repository) by `scripts/sync.ts`, automatically each time Darwin deploys to production. `UPSTREAM.json`
> records the production commit it came from. Changes are
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
installs two policies for it:

- an **ALLOW** policy (`src/permissions/strategy-allow.ts`) listing the only transactions the key may have
  Turnkey sign, and
- a **DENY** policy (`src/permissions/strategy-deny.ts`) blocking everything a key could use to widen its own
  access.

These are enforced by Turnkey, not by Darwin's servers: a request from the position's key that does not match
is refused by Turnkey even if it comes from Darwin. An installed policy is never edited. When Darwin tightens
the ALLOW, the new version is installed as a new policy, and the old one removed, by an in-app step you
approve with your passkey (the "Security update").

### The guarantee (ALLOW generation `s3`, current since the night of 2026-11-03)

**The position's key can only:**

1. **swap inside the position's own wallet, within the bounded swap rule**: a swap through dFlow's router (or
   Jupiter's v6 router as a fallback), signed with the position's wallet, using only an allow-list of swap
   instructions, where
   - **every token-account close in the transaction pays the position's own wallet**;
   - **every token account the transaction creates is owned by the position's wallet** (the Associated Token
     Account program derives the new account's address from its owner, so a create can only make one of the
     position's own token accounts), paid for by the position's wallet or Darwin's relay; and
   - **dFlow's `wrap_sol` can only deposit into the position's own wrapped-SOL account**. And
2. **redeem to your own wallets**: an SPL `TransferChecked` of the position's tokens into one of *your*
   wallets' token accounts (for the redemption mints listed when the position was opened), or a System
   `Transfer` of SOL from the position's wallet to one of *your* wallets.

**So Darwin's key cannot move your tokens or SOL to Darwin or to anyone else.** The ways value can still leave
the position, or sit outside the Turnkey policy text, in a transaction it signs are listed here, stated plainly:

- **Priority fees, capped.** Every transaction the key may sign limits the priority fee to at most 65,535
  micro-lamports per compute unit (about 0.00009 SOL per transaction at the network's compute ceiling). That
  fee goes to Solana's validators, not to Darwin.
- **Rent into your own accounts.** A swap or a token redemption may create a token account. The rent for it
  (about 0.002 SOL) may be paid from the position's wallet, and it goes into the new account, which belongs to
  the position's wallet (swap) or to your wallet (redemption).
- **Rent the relay put in, paid back.** Darwin pays network fees through a fee-paying relay wallet. When the
  relay creates the position's temporary wrapped-SOL account inside a swap, it pays that account's rent, and
  the same transaction may pay that rent back to the relay: at most 1,488,440 lamports (about 0.0015 SOL), and
  only alongside the relay's own *new-account* creation of that wrapped-SOL account. The position's value
  comes out even. No other transfer to the relay is allowed, and no token-account close can pay the relay.
- **The swap's output account is bound by dFlow's program, not by the Turnkey policy text.** dFlow's `swap` /
  `swap2` instructions are admitted by instruction, and the account a swap pays its output into sits at a
  position that depends on the route, so the policy cannot name it. What binds it is dFlow's on-chain program,
  which re-derives the user's token accounts from the signing wallet. Darwin measured that on 2026-09-18 and
  re-simulated part of it on 2026-11-03, but the case of an *existing* account owned by someone else was not
  re-proven against a fresh dFlow build (the captured route no longer executes). This is a residual: it rests on
  dFlow's program, not on the policy. Likewise dFlow's `open_order`,
  `create_referral_token_account_idempotent` and `init_market_ledger_idempotent` are admitted by instruction,
  not by account, and a swap's economics (its route and minimum output) are not bounded by the policy.

Both redemptions are refused if they use address lookup tables, which would hide accounts from the checks.

**The key cannot:**

- send tokens or SOL to anyone except your listed wallets;
- close a token account to anyone but the position's own wallet;
- create a token account owned by anyone but the position's wallet inside a dFlow swap, or wrap SOL into
  anyone else's account;
- approve a delegate, change an account's authority, or use any program outside the lists above;
- sign arbitrary messages or raw payloads, or use Turnkey's send-transaction API;
- add, remove or change API keys, passkeys or any other credential, its own included;
- change MFA policies;
- otherwise act in your sub-organization. In Turnkey's policy model a non-root user needs a policy for every
  activity; the one default exception, a user managing its own credentials, is what the DENY closes.

### Positions created before the night of 2026-11-03: run the "Security update"

Positions opened before the night of 2026-11-03 installed an older ALLOW generation, and keep it until you
update them:

- **`s2`** (positions opened, or updated, on 2026-11-03 before the `s3` release). Inside a dFlow swap, `s2` did
  not bind who owns a token account the transaction creates, or where dFlow's `wrap_sol` deposits. A
  transaction signed by the position's key could therefore have the position's wallet pay the rent of token
  accounts owned by another address (about 0.002 SOL each), or wrap the position's SOL into another address's
  existing wrapped-SOL account. Turnkey would have signed both. `s3` binds both at the Turnkey layer.
- **`s1`** (positions opened before 2026-11-03). Everything `s2` lacks, and in addition a swap could close one of
  the position wallet's token accounts to Darwin's relay wallet (closing a wrapped-SOL account pays out its
  whole SOL balance), and could pay the relay a rent "payback" beside a creation step that puts no rent in.

If you have an older position, open it in Darwin and run **Security update**. It installs the `s3` ALLOW
(named `tax-alpha-allow-<position id>-s3`) and then removes the older one. The redemption part of the policy
(which wallets and tokens redemptions may pay) is carried over unchanged. The verifier reports an older ALLOW
as a warning, separate from a mismatch, naming what it is missing:

- "s2: superseded, missing the dFlow wrap_sol/ATA-owner bounds; run the Security update in Darwin"
- "s1: superseded, missing the relay-close bound and the dFlow wrap_sol/ATA-owner bounds; run the Security
  update in Darwin"

### Read precisely

The ALLOW's text is the guarantee; the sentences above summarize it. Four details matter:

- The rent payback relies on the relay's *new-account* creation, which fails if the account already exists.
  Turnkey cannot check that the creation comes *before* the payback in the transaction, or whether the address
  already held lamports before the account was created. Darwin's own server-side checks cover both, but they
  are not part of what Turnkey enforces. In either case the most that can move is 1,488,440 lamports per transaction,
  and only to Darwin's relay.
- The dFlow-branch account bounds read accounts by position, while dFlow swaps may use address lookup tables.
  Darwin measured that Turnkey keeps a table-loaded account in place (as a placeholder that matches no
  address), so a lookup table cannot satisfy these bounds; that is a property of Turnkey's transaction parser.
- The redemption alternatives bind every transfer to come *from* the position's wallet and go *to* your
  wallets, but do not fix which wallet Turnkey signs with. The key could ask Turnkey to sign a
  redemption-shaped transaction with another wallet of yours as the fee payer. No value can leave that
  wallet except the (capped) transaction fee and, for a token-account creation, rent that goes into your own
  new token account.
- Turnkey `ALLOW` policies add up: any *other* ALLOW naming the position's user would widen what the key may
  do, and that includes an `s1` or `s2` ALLOW left beside the `s3` one. The verifier checks for that.

Program ids that appear in the policies are public: System `11111111111111111111111111111111`, SPL Token
`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`,
Associated Token Account `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, Compute Budget
`ComputeBudget111111111111111111111111111111`, dFlow router `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH`,
Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, and the Memo program
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (used as a key no lookup table can have). Mints: USDC
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, wrapped SOL `So11111111111111111111111111111111111111112`.
Darwin's relay wallet is a parameter of the policy and is not listed here.

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

### 2. Get your installed policies from Turnkey

The policies must come **straight from Turnkey**, read with **your own credential**, so you do not have to
trust Darwin's servers for them. Turnkey policies are not public: they cannot be looked up by wallet address,
and reading them takes a credential in your own Turnkey sub-organization. What you need is the response of
Turnkey's read-only `list_policies` query for your sub-organization:

```
POST https://api.turnkey.com/public/v1/query/list_policies
{ "organizationId": "<your sub-organization id>" }
```

- **Planned: a "Download my installed permissions" button in Darwin.** Your passkey was created at
  darwin.finance and only works on Darwin's pages, so this button is how most people will do it. Its browser
  code will send the request above from your browser directly to `api.turnkey.com`, signed with your passkey,
  and save Turnkey's response unmodified. You can confirm in your browser's developer tools (Network tab) that
  the request goes to `api.turnkey.com`, not to Darwin. Until it ships, use the advanced path.
- **Advanced: your own read-only API key, no Darwin involvement.** Create an API key in your own Turnkey
  sub-organization for a user that has no ALLOW policy. Such a key can run queries such as `list_policies` and
  nothing else. (Creating it is a change to your sub-organization, so it needs your root credential, your
  passkey, to approve it.) Then let the verifier fetch the policies itself, straight from `api.turnkey.com`:

  ```sh
  export TURNKEY_READONLY_API_PRIVATE_KEY=<the key's private half, hex>   # never printed or saved
  bun src/verify/cli.ts --params position.json --fetch --organization <your sub-organization id> --save policies.json
  ```

  The verifier signs the one request with the key (Turnkey's standard API-key stamp), sends it to
  `https://api.turnkey.com/public/v1/query/list_policies` and nowhere else, refuses redirects, and saves
  Turnkey's response with `--save`. The code is `src/verify/fetch.ts`. You can also send the request with
  Turnkey's CLI or any Turnkey SDK (`getPolicies`) and pass the saved JSON with `--export`.

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

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Pass: the installed policies are exactly the current (`s3`) templates. |
| 1 | Mismatch: something differs (the output shows the first differing character), or another ALLOW names the position's signer. |
| 2 | The input could not be read (or the policies could not be fetched). |
| 3 | Superseded: an installed ALLOW is exactly an older (`s1` or `s2`) template, and nothing else differs. Run the Security update in Darwin. |

`--json` prints a machine-readable result (`ok`, `superseded`, `supersededGenerations`, `generation`, `checks`); `--print-expected`
prints the policies the parameters should produce. Try it on the examples in `test/vectors/`
(`position-a` passes; `position-b` has an extra redemption wallet and fails; `position-c` is an `s1` position from
before 2026-11-03 and `position-d` an `s2` position from 2026-11-03; both report superseded).

The verifier is also a library: `verifyPosition(params, parsePolicyExport(json))` from `src/verify`.

## Repository layout and development

```
src/rules/         strategy rules (pure functions)
src/permissions/   the ALLOW / DENY templates, rendered from a position's parameters
src/verify/        the verifier library and CLI (fetch.ts: the optional direct read from api.turnkey.com)
test/upstream/     production's unit tests for the published rules (generated)
test/              tests for the templates, the verifier and the hand-ported rules; test/vectors/ fixtures
scripts/           sync.ts regenerates the mirror from a production checkout; scan.ts is the forbidden-content
                   scan (see sync-from-upstream.md)
```

```sh
bun install
bun test
bunx tsc --noEmit
```

Requires [Bun](https://bun.sh) 1.2 or later. Runtime dependencies: `@solana/web3.js` and `@solana/spl-token`
(for address derivation only). Nothing here connects to a network, except the verifier's optional `--fetch`,
which talks only to `api.turnkey.com`.

Security issues: see [SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
