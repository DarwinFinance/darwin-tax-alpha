# Syncing this mirror from production

This repository is generated from Darwin's private production repository. Nothing here talks to production,
and the mirror has no automation that needs credentials: a person runs the sync from a production checkout,
reviews the diff, and publishes it.

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
   fails until a person re-checks the port and re-runs with `--accept-pins`.
4. **Permission text, byte for byte.** For every test vector, the ALLOW and DENY are rendered by the
   production builder and by this repository; they must be identical. Darwin's real relay address is read
   from production at run time, replaced by the vector's placeholder, and never written to disk.
5. **No stray files.** Every file in the repository must be in the manifest or in `STATIC_FILES`; every
   import must be relative or one of the allowed packages.

## Publishing a sync (planned process)

1. Check out the production commit to mirror (normally the commit currently deployed to production).
2. Run `bun scripts/sync.ts --upstream <checkout>`; then `bun test` and `bunx tsc --noEmit`.
3. Review the diff. Run the secret / identifier scan (gitleaks, plus a search for base58 strings that are
   not the public program ids and mints listed in the README).
4. Update `CHANGES-FROM-UPSTREAM.md` if a hand port changed, then commit with the production commit sha in
   the message and push.

A later step may run `--check` from production's own CI on changes that touch a file in the manifest, so
that a production change which would alter the published permission text is flagged before it merges. That
belongs in production's CI (which already has the checkout); this mirror deliberately has no workflows.
