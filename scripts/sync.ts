#!/usr/bin/env bun
/**
 * Regenerate this repository's published files from a checkout of the private monorepo, and check that
 * nothing outside the manifest has crept in.
 *
 *   bun scripts/sync.ts --upstream /path/to/monorepo           regenerate (writes files + UPSTREAM.json)
 *   bun scripts/sync.ts --upstream /path/to/monorepo --check   verify only; exit 1 on any drift
 *   ... --accept-pins   (regenerate mode) record new upstream hashes for hand ports after a person re-checked them
 *
 * What it does, in order:
 *   1. Refuses a manifest entry that draws on an excluded upstream area (scripts/sync-manifest.ts).
 *   2. Regenerates every `file`, `decls` and `test` entry: upstream code with comments stripped and imports
 *      rewritten. Unmapped imports are an error, so a new upstream dependency cannot be published silently.
 *   3. For every `hand` entry, hashes the pinned upstream declarations and compares them with UPSTREAM.json.
 *      A changed hash means upstream moved and the hand port must be re-checked by a person.
 *   4. Renders the permission policies for every test vector with BOTH the upstream builder and this
 *      repository's builder, and requires byte equality — the CURRENT generation and every SUPERSEDED
 *      generation the verifier recognises (the upstream relay address is substituted with the vector's
 *      placeholder before comparing; it is never written to disk).
 *   5. Lists every file in this repository (git ls-files + untracked) and fails on anything that is not in
 *      the manifest or STATIC_FILES, and on any import that is not relative or an allowed package.
 */
import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ALLOWED_PACKAGES, EXCLUDED_UPSTREAM, MANIFEST, STATIC_FILES, type Entry } from "./sync-manifest";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const upstreamArg = args[args.indexOf("--upstream") + 1];
const CHECK = args.includes("--check");
/** Regenerate mode only: record new hashes for hand ports a person has re-checked. */
const ACCEPT_PINS = args.includes("--accept-pins");
if (!args.includes("--upstream") || !upstreamArg) {
  console.error("usage: bun scripts/sync.ts --upstream <monorepo checkout> [--check]");
  process.exit(2);
}
const UP = resolve(upstreamArg);
const failures: string[] = [];
const fail = (m: string) => failures.push(m);

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function parse(path: string): ts.SourceFile {
  const abs = join(UP, path);
  if (!existsSync(abs)) throw new Error(`upstream file missing: ${path}`);
  return ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function namesOf(st: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) {
    return st.name ? [st.name.text] : [];
  }
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  return [];
}

const print = (node: ts.Node, sf: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, sf);

function rewriteSpecifier(spec: string, map: Record<string, string> | undefined, where: string): string {
  if (spec === "vitest") return "bun:test";
  if (map && spec in map) return map[spec]!;
  if (ALLOWED_PACKAGES.includes(spec)) return spec;
  throw new Error(`${where}: unmapped import '${spec}' — add it to the manifest's imports map (or exclude the code that needs it)`);
}

function printWithImports(sf: ts.SourceFile, map: Record<string, string> | undefined, where: string): string {
  const out: string[] = [];
  for (const st of sf.statements) {
    let text = print(st, sf);
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      text = text.replace(JSON.stringify(spec), JSON.stringify(rewriteSpecifier(spec, map, where)));
    }
    // Upstream mocks (vi.mock) would point at modules that do not exist here.
    if (/\bvi\.mock\(/.test(text)) throw new Error(`${where}: vi.mock is not portable — port this test by hand`);
    out.push(text);
  }
  return out.join("\n");
}

function declTexts(path: string, decls: string[], exportNames: string[] = []): Map<string, string> {
  const sf = parse(path);
  const found = new Map<string, string>();
  for (const st of sf.statements) {
    const names = namesOf(st).filter((n) => decls.includes(n));
    if (names.length === 0) continue;
    let text = print(st, sf);
    if (names.some((n) => exportNames.includes(n)) && !/^export\b/.test(text)) text = `export ${text}`;
    for (const n of names) found.set(n, text);
  }
  for (const d of decls) if (!found.has(d)) throw new Error(`${path}: declaration '${d}' not found upstream`);
  return found;
}

const header = (sources: string[]) =>
  `// GENERATED by scripts/sync.ts from the Darwin monorepo — do not edit by hand.\n` +
  `// Source: ${sources.join(", ")} (commit in UPSTREAM.json). Upstream comments are stripped; see README.md.\n`;

function generate(e: Entry): string | null {
  if (e.kind === "hand") return null;
  const srcs = e.kind === "decls" ? e.sources.map((s) => s.upstream) : [e.upstream];
  for (const s of srcs) for (const bad of EXCLUDED_UPSTREAM) if (s.includes(bad)) throw new Error(`${e.out}: draws on excluded upstream area '${bad}' (${s})`);
  if (e.kind === "file" || e.kind === "test") return header(srcs) + "\n" + printWithImports(parse(e.upstream), e.imports, e.out) + "\n";
  const parts: string[] = [];
  if (e.header) parts.push(e.header);
  for (const s of e.sources) {
    const texts = declTexts(s.upstream, s.decls, s.export);
    // Source order, de-duplicated (one statement can declare several names).
    const sf = parse(s.upstream);
    const seen = new Set<string>();
    for (const st of sf.statements) {
      const names = namesOf(st).filter((n) => s.decls.includes(n));
      if (names.length === 0) continue;
      const t = texts.get(names[0]!)!;
      if (!seen.has(t)) { seen.add(t); parts.push(t); }
    }
  }
  return header(srcs) + "\n" + parts.join("\n\n") + "\n";
}

// ── 1–3: generate / check files and pins ─────────────────────────────────────────────────────────────
const upstreamJsonPath = join(ROOT, "UPSTREAM.json");
const prior = existsSync(upstreamJsonPath) ? JSON.parse(readFileSync(upstreamJsonPath, "utf8")) : { pins: {} };
const commit = execFileSync("git", ["-C", UP, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const pins: Record<string, string> = {};
const sources: Record<string, string> = {};

for (const e of MANIFEST) {
  try {
    if (e.kind === "hand") {
      for (const p of e.pins) {
        const texts = declTexts(p.upstream, p.decls);
        for (const d of p.decls) {
          const key = `${p.upstream}#${d}`;
          pins[key] = sha256(texts.get(d)!);
          const moved = prior.pins?.[key] !== undefined && prior.pins[key] !== pins[key];
          if ((CHECK && prior.pins?.[key] !== pins[key]) || (!CHECK && moved && !ACCEPT_PINS)) fail(`${e.out}: upstream ${key} changed since the hand port — re-check it and update CHANGES-FROM-UPSTREAM.md`);
        }
        sources[p.upstream] = sha256(readFileSync(join(UP, p.upstream), "utf8"));
      }
      if (!existsSync(join(ROOT, e.out))) fail(`${e.out}: hand-written file missing`);
      continue;
    }
    const text = generate(e)!;
    for (const s of e.kind === "decls" ? e.sources.map((x) => x.upstream) : [e.upstream]) sources[s] = sha256(readFileSync(join(UP, s), "utf8"));
    const dest = join(ROOT, e.out);
    const current = existsSync(dest) ? readFileSync(dest, "utf8") : null;
    if (CHECK) {
      if (current !== text) fail(`${e.out}: differs from what upstream generates`);
    } else if (current !== text) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
      console.log(`wrote ${e.out}`);
    }
  } catch (err) {
    fail((err as Error).message);
  }
}


/**
 * An example Turnkey `list_policies` response for a vector (all ids are random placeholders):
 *   position-a — the position's two policies plus an unrelated policy of the user's own: PASSES.
 *   position-b — the ALLOW's SOL-redemption destinations carry one extra (attacker) wallet: FAILS.
 *   position-c — a position set up before 2026-11-03: its ALLOW is the SUPERSEDED s1 text: WARNS (superseded).
 *   position-d — a position set up on 2026-11-03 before the s3 release: its ALLOW is the SUPERSEDED s2 text: WARNS.
 *   position-e — a position set up on 2026-11-04 before the s5 release: its ALLOW is the SUPERSEDED s4 text: WARNS.
 */
const ATTACKER_PLACEHOLDER = "E2zF382BRWbzYQYgHVeUUEDrn1mpib7ZzyG8RjRFTgHw";
type Older = "s1" | "s2" | "s3" | "s4";
const OLDER_FOR: Readonly<Record<string, Older>> = { "position-c": "s1", "position-d": "s2", "position-e": "s4" };
function exampleExport(v: string, e: { allow: Record<string, unknown>; deny: Record<string, unknown> }, older: Record<Older, Record<string, unknown>>) {
  const allow = OLDER_FOR[v] ? { ...older[OLDER_FOR[v]!] } : { ...e.allow };
  if (v === "position-b") {
    const c = String(allow.condition);
    const at = c.lastIndexOf("j.accounts[1].account_key in ['");
    if (at < 0) throw new Error("cannot build the tampered example");
    const open = at + "j.accounts[1].account_key in [".length;
    allow.condition = `${c.slice(0, open)}'${ATTACKER_PLACEHOLDER}', ${c.slice(open)}`;
  }
  const ids = v === "position-a"
    ? ["0b8f3c52-6d0e-4f43-9a51-6f2f0d6a1a01", "0b8f3c52-6d0e-4f43-9a51-6f2f0d6a1a02", "0b8f3c52-6d0e-4f43-9a51-6f2f0d6a1a03"]
    : v === "position-b"
      ? ["5d1e2a90-3c7b-4e88-8f0a-2b9c4d6e7f01", "5d1e2a90-3c7b-4e88-8f0a-2b9c4d6e7f02", "5d1e2a90-3c7b-4e88-8f0a-2b9c4d6e7f03"]
      : v === "position-c"
        ? ["a37c91d4-0e52-4b6f-8d13-5f7e2c9b4a01", "a37c91d4-0e52-4b6f-8d13-5f7e2c9b4a02", "a37c91d4-0e52-4b6f-8d13-5f7e2c9b4a03"]
        : v === "position-d"
          ? ["fb4307b6-9d09-493e-b57c-c4b9634e9501", "fb4307b6-9d09-493e-b57c-c4b9634e9502", "fb4307b6-9d09-493e-b57c-c4b9634e9503"]
          : ["6e2d8a41-57c3-4b9e-a0f6-3d1c9e8b7e01", "6e2d8a41-57c3-4b9e-a0f6-3d1c9e8b7e02", "6e2d8a41-57c3-4b9e-a0f6-3d1c9e8b7e03"];
  return {
    policies: [
      { policyId: ids[0], policyName: allow.policyName, effect: allow.effect, consensus: allow.consensus, condition: allow.condition, notes: allow.notes },
      { policyId: ids[1], policyName: e.deny.policyName, effect: e.deny.effect, consensus: e.deny.consensus, condition: e.deny.condition, notes: e.deny.notes },
      { policyId: ids[2], policyName: "example-unrelated-user-policy", effect: "EFFECT_ALLOW", consensus: "approvers.any(user, user.id == '9c0f4f7e-1111-4222-8333-944455556666')", condition: "activity.kind == 'SIGN_TRANSACTION'", notes: "An unrelated policy of the user's own (placeholder)." },
    ],
  };
}

// ── 4: permission text, upstream vs this repository, byte for byte ───────────────────────────────────
const vectors = ["position-a", "position-b", "position-c", "position-d", "position-e"];
try {
  const upAllow = await import(join(UP, "src/lib/strategy/custody/strategy-allow.ts"));
  const upSetup = await import(join(UP, "src/lib/strategy/custody/setup.ts"));
  const upRelay: string = (await import(join(UP, "src/lib/gas/pinned-relay.ts"))).DARWIN_GAS_RELAY_WALLET;
  const ours = await import(join(ROOT, "src/permissions/position.ts"));
  for (const v of vectors) {
    const params = JSON.parse(readFileSync(join(ROOT, `test/vectors/${v}.params.json`), "utf8"));
    const upArgs = { strategyWallet: params.strategyWallet, userWallets: params.userWallets, redemptionMints: params.redemptionMints, enrollmentId: params.enrollmentId, strategyUserId: params.strategyUserId };
    const sub = (s: string) => s.split(upRelay).join(params.darwinRelayWallet);
    const upAllowBody = upAllow.buildStrategyAllowPolicyBody(upArgs);
    const upDenyBody = upSetup.buildStrategyDenyPolicyBody(upArgs);
    const expected = {
      allow: { policyName: upAllowBody.policyName, effect: upAllowBody.effect, consensus: upAllowBody.consensus, condition: sub(upAllowBody.condition), notes: upAllowBody.notes },
      deny: { policyName: upDenyBody.policyName, effect: upDenyBody.effect, consensus: upDenyBody.consensus, condition: upDenyBody.condition, notes: upDenyBody.notes },
    };
    if (expected.allow.condition.includes(upRelay) || JSON.stringify(expected).includes(upRelay)) throw new Error("relay substitution failed");
    const mine = ours.expectedPositionPolicies(params);
    if (JSON.stringify(mine) !== JSON.stringify(expected)) fail(`permission text for ${v}: this repository's renderer differs from upstream`);
    // Every superseded generation the verifier recognises, rendered by upstream's own generation parameter.
    if (upAllow.CURRENT_STRATEGY_ALLOW_GENERATION !== "s5-jupiter-only") fail(`upstream's current strategy generation is '${upAllow.CURRENT_STRATEGY_ALLOW_GENERATION}', not s5 — port it`);
    const older = {} as Record<Older, Record<string, unknown>>;
    for (const [short, g] of [["s1", "s1-agent-v9-swap"], ["s2", "s2-relay-close-bound"], ["s3", "s3-dflow-accounts-bound"], ["s4", "s4-dflow-names-narrowed"]] as const) {
      const upOld = sub(upAllow.strategyAllowCondition(upArgs, g));
      if (upOld.includes(upRelay)) throw new Error(`relay substitution failed (${short})`);
      older[short] = { ...expected.allow, condition: upOld };
      if (ours.supersededAllowPolicy(params, g).condition !== upOld) fail(`superseded ${short} permission text for ${v}: this repository's renderer differs from upstream`);
    }
    for (const [suffix, body] of [["expected", expected], ["export", exampleExport(v, expected, older)]] as const) {
      const path = join(ROOT, `test/vectors/${v}.${suffix}.json`);
      const text = JSON.stringify(body, null, 2) + "\n";
      const cur = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (CHECK) { if (cur !== text) fail(`test/vectors/${v}.${suffix}.json is stale`); }
      else if (cur !== text) { writeFileSync(path, text); console.log(`wrote test/vectors/${v}.${suffix}.json`); }
    }
  }
} catch (err) {
  fail(`permission differential check: ${(err as Error).message}`);
}

// ── 5: nothing unlisted, no stray imports ────────────────────────────────────────────────────────────
const listed = new Set([...MANIFEST.map((e) => e.out), ...STATIC_FILES]);
const files = execFileSync("git", ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n").filter(Boolean);
for (const f of files) {
  if (!listed.has(f)) fail(`unlisted file in the repository: ${f} (add it to the manifest deliberately, or delete it)`);
  if (/\.(ts|tsx|js|mjs)$/.test(f) && existsSync(join(ROOT, f))) {
    const sf = ts.createSourceFile(f, readFileSync(join(ROOT, f), "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        if (!spec.startsWith(".") && !ALLOWED_PACKAGES.includes(spec)) fail(`${f}: imports '${spec}', which is not an allowed package`);
      }
    }
  }
}

if (!CHECK && failures.length === 0) {
  // Never record new hashes on a failed run: a moved pin must stay moved until --accept-pins.
  const out = { repository: "DarwinFinance/darwin", commit, note: "Files listed in scripts/sync-manifest.ts were generated from this commit.", sources, pins };
  writeFileSync(upstreamJsonPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`UPSTREAM.json → ${commit}`);
} else if (prior.commit !== commit) {
  console.log(`note: UPSTREAM.json records ${prior.commit}; this checkout is ${commit}`);
}

if (failures.length) {
  console.error(`\nsync FAILED (${failures.length}):\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log(CHECK ? "sync check: OK" : "sync: OK");
