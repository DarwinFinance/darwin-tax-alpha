# Test vectors

Every address and id in these files is a placeholder. The Solana addresses were generated at random for
this repository and have never been funded; the Turnkey ids are random UUIDs.

| File | What it is |
|------|------------|
| `position-*.params.json` | The parameters of an example position, in the shape the verifier takes. |
| `position-*.expected.json` | The ALLOW and DENY that position installs, rendered by the **upstream** (production) builder in `scripts/sync.ts`. The tests require this repository's renderer to produce the same bytes. |
| `position-a.export.json` | An example Turnkey `list_policies` response for position A: its two policies plus an unrelated policy. The verifier PASSES it. |
| `position-b.export.json` | The same for position B, except the ALLOW's SOL-redemption destinations carry one extra wallet. The verifier FAILS it. |

The upstream builder pins Darwin's real relay address; `scripts/sync.ts` substitutes the placeholder
`darwinRelayWallet` from the params file before comparing or writing, so the real address never lands here.
