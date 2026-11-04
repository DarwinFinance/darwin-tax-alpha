# Syncing this mirror from production

This repository is generated from Darwin's private production repository. Nothing here talks to production,
and this repository has no workflows of its own. It is updated **automatically when Darwin deploys to
production**, by a workflow in the production repository (below), and by hand when the automation stops and asks
for a person.

## What `scripts/sync.ts` does

```sh
# from a checkout of this repository, with a production checkout next to it
bun install
bun scripts/sync.ts --upstream ../darwin            # regenerate
bun scripts/sync.ts --upstream ../darwin --check    # verify only (exit 1 on any drift)
```

1. **Source allow-list.** Every published file comes from `scripts/sync-manifest.ts`. An entry that draws on
   an excluded production area (server-side signing guards and pipelines, relay / fee-payer logic, kill
   switches, MFA / recovery / session design, monitoring, scheduling) fails the sync.
2. **Regenerate.** Whole modules (`file`), named declarations lifted from mixed modules (`decls`) and
   production unit tests (`test`) are regenerated with comments stripped and imports rewritten. An import
   the manifest does not map is an error, so a new production dependency cannot be published by accident.
3. **Hand ports are pinned.** Files written by hand (`hand`, listed in `CHANGES-FROM-UPSTREAM.md`) record a
   hash of each production declaration they mirror in `UPSTREAM.json`. If production changes one, the sync
   fails until a person re-checks the port and re-runs with `--accept-pins`. A failed run never rewrites
   `UPSTREAM.json`, so a moved pin stays failing until it is accepted.
4. **Permission text, byte for byte.** For every test vector, the ALLOW and DENY are rendered by the
   production builder and by this repository; they must be identical. That covers the current ALLOW generation
   (`s3-dflow-accounts-bound`) and the superseded ones the verifier recognises (`s2-relay-close-bound`,
   `s1-agent-v9-swap`), and the sync fails if production's current generation is no longer `s3`. Darwin's real relay address is read from
   production at run time, replaced by the vector's placeholder, and never written to disk.
5. **No stray files.** Every file in the repository must be in the manifest or in `STATIC_FILES`; every
   import must be relative or one of the allowed packages.

## Forbidden-content scan

```sh
bun scripts/scan.ts --upstream ../darwin                       # base58 addresses, internal names, the relay address
gitleaks dir . --no-banner --redact --config .gitleaks.toml    # secrets
```

`scripts/scan.ts` fails on any base58 string of address length that is not a public program id or mint listed
in the README or a test-vector placeholder (or an address derived from one), on internal names (developer
paths, internal hostnames, internal service and environment names), and, with `--upstream`, on Darwin's real
relay address, which it reads from the production checkout without printing it. `.gitleaks.toml` extends
gitleaks' default rules and allowlists only public addresses inside policy text, the content hashes in
`UPSTREAM.json`, and the Memo program id.

## Automatic sync on every production deploy

The production repository's `.github/workflows/tax-alpha-mirror.yml` runs when a promotion to production
("Promote beta → production") succeeds, and on demand (`workflow_dispatch`, optionally with a `sha`). It:

1. finds the sha the promotion **deployed** (the gate's resolved sha, which must equal the deploy job's checkout
   ref; not `main` HEAD), and checks production out at it;
2. clones this repository over HTTPS with a short-lived token from the **"Darwin Tax Alpha Mirror" GitHub App**.
   The App is installed on this repository only, with Contents: read and write. Its id and private key are the
   production repository's Actions secrets `TAX_ALPHA_MIRROR_APP_ID` and `TAX_ALPHA_MIRROR_APP_PRIVATE_KEY`.
   `actions/create-github-app-token` mints an installation token scoped to this one repository (contents:
   write), which is masked in logs and revoked when the job ends. git gets it through a one-command credential
   helper, so it is never in a URL or in `.git/config`. If either secret is missing, the run fails at its first
   step and says so. (Deploy keys are disabled by the enterprise policy.) Commits are authored by the App's bot
   identity;
3. runs `bun scripts/sync.ts --upstream <that checkout>` (regenerate, **without** `--accept-pins`), then
   `--check`, `bun test`, `bunx tsc --noEmit`, `bun scripts/scan.ts --upstream <checkout>` and gitleaks;
4. pushes one commit to `main` ("Sync from DarwinFinance/darwin@<sha>") only if a published file changed. A new
   sha that changes nothing but `UPSTREAM.json`'s `commit` field is not pushed.

**If any step fails, nothing is pushed and the run is red**, with the reason in the job summary. The usual
reason is intended: production changed a declaration a hand port mirrors (its pinned hash moved), the permission
text this repository renders no longer matches production's byte for byte, or a published module gained an
import the manifest does not map. That needs a person (next section).

## Re-porting by hand

1. Check out the production commit to mirror (normally the commit currently deployed to production) in a
   fresh directory.
2. Run `bun scripts/sync.ts --upstream <checkout>` and read the failures.
3. Re-port the hand-written files named (`CHANGES-FROM-UPSTREAM.md` lists what each mirrors). If the permission
   text changed, decide whether the verifier should recognise the old generation as superseded (as it does
   for `s1` and `s2`), and update the README's description of what the key can do.
4. Run `bun scripts/sync.ts --upstream <checkout> --accept-pins`, then `bun test`, `bunx tsc --noEmit`, and the
   scan above.
5. Review the diff, update `CHANGES-FROM-UPSTREAM.md`, commit with the production commit sha in the message and
   push to `main`. The next production deploy's automatic sync then runs clean.
