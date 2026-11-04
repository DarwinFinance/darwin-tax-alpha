#!/usr/bin/env bun
/**
 * Forbidden-content scan, run before anything is published from this repository.
 *
 *   bun scripts/scan.ts                         scan every file the repository would publish
 *   bun scripts/scan.ts --upstream <checkout>   also require that Darwin's real relay address (read from the
 *                                               production checkout at run time, never printed) appears nowhere
 *
 * Fails (exit 1) on:
 *   1. a base58 string of Solana-address length that is not a public program id / mint listed in README.md or
 *      a test-vector placeholder (or an address derived from one) — so no real wallet, user or org id slips in;
 *   2. an internal name: developer paths and accounts, internal hostnames, internal service and env names;
 *   3. Darwin's real relay address (with --upstream).
 * Secrets are covered separately by gitleaks (see scripts/sync-from-upstream.md). Findings are reported by file
 * and line with the match redacted.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const upstreamAt = args.indexOf("--upstream");
const UP = upstreamAt >= 0 ? resolve(args[upstreamAt + 1] ?? "") : null;

/** Public, well-known program ids and mints (README.md lists them). */
const PUBLIC_IDS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "So11111111111111111111111111111111111111112",
];
/** The tampered-export attacker placeholder (scripts/sync.ts). */
const EXTRA_PLACEHOLDERS = ["E2zF382BRWbzYQYgHVeUUEDrn1mpib7ZzyG8RjRFTgHw"];

/** Case-insensitive internal names that must never be published. */
const INTERNAL = [
  /kylesamani/i, /\/Users\//, /DevNew/i, /cg-ops/i, /\bcgpd\b/i, /ccharts/i,
  /\.workers\.dev/i, /\.internal\b/i, /beta\.darwin\.finance/i, /neon\.tech/i, /\bneondb/i, /NEON_[A-Z_]+/,
  /doppler/i, /helius-rpc\.com/i, /api-key=/i, /digitalocean/i, /droplet/i, /\bsentry\b/i,
  /DARWIN_GAS_RELAY_WALLET/, /pinned-relay/, /TURNKEY_API_PRIVATE_KEY/, /TURNKEY_STANDING_/, /INTERNAL_INGESTION_SECRET/,
  /CLOUDFLARE_API_TOKEN/, /\bR2_[A-Z_]+/, /org-[a-z]+-[a-z]+-\d{6,}/,
];
/** Files where a given internal-name rule is expected (documentation of the scan itself, the sync tool). */
const INTERNAL_EXEMPT: Record<string, string[]> = {
  "scripts/scan.ts": INTERNAL.map((r) => r.source),
  // sync.ts imports the relay constant from the production checkout to substitute it; it never writes it.
  "scripts/sync.ts": ["DARWIN_GAS_RELAY_WALLET", "pinned-relay"],
  // The manifest's list of production areas that may never be a source.
  "scripts/sync-manifest.ts": ["\\bsentry\\b"],
  // Owner, 2026-11-04: "How to verify" names the beta host's verification-key page next to production's. Only the
  // README, and only that host; the rule still holds everywhere else.
  "README.md": ["beta\\.darwin\\.finance"],
};

const BASE58 = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
/** Files whose base58-looking strings are not addresses (package integrity hashes). */
const BASE58_EXEMPT = new Set(["bun.lock"]);

function publishedFiles(): string[] {
  return execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n").filter((f) => f && existsSync(join(ROOT, f)));
}

/** Placeholders from the vectors, plus every address derived from them (ATAs on both token programs). */
function allowedAddresses(): Set<string> {
  const allowed = new Set([...PUBLIC_IDS, ...EXTRA_PLACEHOLDERS]);
  const owners: string[] = [];
  const mints: string[] = [...PUBLIC_IDS];
  for (const f of publishedFiles().filter((x) => /^test\/vectors\/.*\.params\.json$/.test(x))) {
    const p = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
    for (const a of [p.strategyWallet, p.darwinRelayWallet, ...(p.userWallets ?? [])]) { allowed.add(a); owners.push(a); }
    for (const m of p.redemptionMints ?? []) { allowed.add(m); mints.push(m); }
  }
  for (const o of owners) for (const m of mints) for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try { allowed.add(getAssociatedTokenAddressSync(new PublicKey(m), new PublicKey(o), true, prog).toBase58()); } catch { /* not a key */ }
  }
  return allowed;
}

const redact = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`);

async function main(): Promise<number> {
  const findings: string[] = [];
  const allowed = allowedAddresses();
  let relay: string | null = null;
  if (UP) {
    const path = join(UP, "src/lib/gas/pinned-relay.ts");
    if (!existsSync(path)) { console.error("scan: --upstream given but the relay module is missing there"); return 2; }
    relay = String((await import(path)).DARWIN_GAS_RELAY_WALLET ?? "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(relay)) { console.error("scan: could not read the relay address from upstream"); return 2; }
  }
  for (const f of publishedFiles()) {
    const text = readFileSync(join(ROOT, f), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      if (relay && line.includes(relay)) findings.push(`${at}: Darwin's real relay address`);
      for (const rule of INTERNAL) {
        if ((INTERNAL_EXEMPT[f] ?? []).includes(rule.source)) continue;
        const m = line.match(rule);
        if (m) findings.push(`${at}: internal name ${rule} (${redact(m[0])})`);
      }
      if (BASE58_EXEMPT.has(f)) return;
      for (const m of line.matchAll(BASE58)) {
        const s = m[0];
        if (allowed.has(s)) continue;
        // Not an address unless it decodes to 32 bytes (prose, hex, identifiers otherwise).
        try { new PublicKey(s); } catch { continue; }
        if (/^[0-9a-f]+$/.test(s) || /^[A-Za-z]+$/.test(s)) continue; // hex digests / plain words
        findings.push(`${at}: unlisted base58 address ${redact(s)}`);
      }
    });
  }
  if (findings.length) {
    console.error(`scan FAILED (${findings.length}):\n - ${findings.join("\n - ")}`);
    return 1;
  }
  console.log(`scan: OK (${publishedFiles().length} files${relay ? ", relay address absent" : ""})`);
  return 0;
}

process.exit(await main());
