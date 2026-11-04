#!/usr/bin/env bun
/**
 * darwin-tax-alpha-verify — check a Tax Alpha position's installed Turnkey permissions.
 *
 *   bun src/verify/cli.ts --params position.json --export policies.json [--json]
 *   bun src/verify/cli.ts --params position.json --fetch --organization <sub-org id> [--save policies.json] [--json]
 *   bun src/verify/cli.ts --params position.json --print-expected
 *   bun src/verify/cli.ts --key darwin-verification-key-<date>.json [--params position.json] [--save policies.json] [--json]
 *
 * --key uses the READ-ONLY verification key file you create at https://darwin.finance/verify-tax-alpha: it holds your
 * sub-organization id, the key, and the public parameters of each of your positions, so no other input is needed. The
 * verifier fetches your policies with it, checks the key's own read-only DENY is installed, then checks every position.
 *
 * --fetch reads the policies straight from api.turnkey.com with YOUR OWN Turnkey API key, taken from the
 * environment (TURNKEY_READONLY_API_PRIVATE_KEY, optionally TURNKEY_READONLY_API_PUBLIC_KEY). The key is
 * never printed or saved. See src/verify/fetch.ts.
 *
 * Exit codes: 0 pass, 1 mismatch, 2 bad input, 3 superseded (an s1 or s2 ALLOW is installed; nothing else differs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { expectedPositionPolicies, validatePositionParams } from "../permissions/position";
import { parsePolicyExport } from "./export";
import { ENV_PRIVATE_KEY, ENV_PUBLIC_KEY, fetchInstalledPolicies, type FetchLike } from "./fetch";
import { formatResult, verifyPosition, type VerifyResult } from "./verify";
import { checkVerificationDeny, parseKeyFile, type VerificationKeyFile } from "./key-file";
import type { InstalledPolicy } from "./export";
import type { PositionParams } from "../permissions/position";

/** Where a verification key file is created (and revoked). */
export const VERIFY_PAGE_URL = "https://darwin.finance/verify-tax-alpha";

const USAGE = `usage:
  darwin-tax-alpha-verify --key <darwin-verification-key-<date>.json> [--params <position.json>] [--save <file>] [--json]
      (create the read-only key file at ${VERIFY_PAGE_URL}, signed in to Darwin)
  darwin-tax-alpha-verify --params <position.json> --export <turnkey-policies.json> [--json]
  darwin-tax-alpha-verify --params <position.json> --fetch --organization <sub-org id> [--save <file>] [--json]
      (reads ${ENV_PRIVATE_KEY} from the environment; never printed)
  darwin-tax-alpha-verify --params <position.json> --print-expected`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  read: (p: string) => string;
  write?: (p: string, s: string) => void;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) { io.out(USAGE); return 0; }
  if (argv.includes("--key")) return runWithKeyFile(argv, opt("--key"), io);
  const paramsPath = opt("--params");
  if (!paramsPath) { io.err(USAGE); return 2; }
  let params: unknown;
  try {
    params = JSON.parse(io.read(paramsPath));
    validatePositionParams(params);
  } catch (e) {
    io.err(`bad parameters (${paramsPath}): ${(e as Error).message}`);
    return 2;
  }
  if (argv.includes("--print-expected")) {
    io.out(JSON.stringify(expectedPositionPolicies(params), null, 2));
    return 0;
  }
  const exportPath = opt("--export");
  let installed;
  if (argv.includes("--fetch")) {
    const organizationId = opt("--organization");
    const privateKeyHex = io.env?.[ENV_PRIVATE_KEY];
    if (!organizationId || exportPath) { io.err(USAGE); return 2; }
    if (!privateKeyHex) { io.err(`--fetch needs your Turnkey API private key in ${ENV_PRIVATE_KEY}`); return 2; }
    let body: unknown;
    try {
      body = await fetchInstalledPolicies({ organizationId, privateKeyHex: privateKeyHex.trim(), publicKeyHex: io.env?.[ENV_PUBLIC_KEY]?.trim() || undefined, fetchImpl: io.fetch });
      installed = parsePolicyExport(body);
    } catch (e) {
      io.err(`could not fetch the policies from Turnkey: ${(e as Error).message}`);
      return 2;
    }
    const savePath = opt("--save");
    if (savePath) (io.write ?? writeFileSync)(savePath, JSON.stringify(body, null, 2) + "\n");
  } else {
    if (!exportPath) { io.err(USAGE); return 2; }
    try {
      installed = parsePolicyExport(JSON.parse(io.read(exportPath)));
    } catch (e) {
      io.err(`bad policy export (${exportPath}): ${(e as Error).message}`);
      return 2;
    }
  }
  const result = verifyPosition(params, installed);
  io.out(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatResult(result));
  return !result.ok ? 1 : result.superseded ? 3 : 0;
}

/** --key: the verification key file supplies the organization, the key and the positions. */
async function runWithKeyFile(argv: string[], keyPath: string | undefined, io: CliIo): Promise<number> {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!keyPath || argv.includes("--export") || argv.includes("--print-expected")) { io.err(USAGE); return 2; }
  let file: VerificationKeyFile;
  try {
    file = parseKeyFile(JSON.parse(io.read(keyPath)));
  } catch (e) {
    io.err(`bad verification key file (${keyPath}): ${(e as Error).message}. Create one at ${VERIFY_PAGE_URL}`);
    return 2;
  }
  const organization = opt("--organization");
  if (organization !== undefined && organization !== file.organizationId) {
    io.err("--organization differs from the key file's organizationId; omit it, the key file names your sub-organization");
    return 2;
  }
  let targets: Array<{ label: string; params: PositionParams | null }>;
  const paramsPath = opt("--params");
  if (paramsPath) {
    try {
      const params: unknown = JSON.parse(io.read(paramsPath));
      validatePositionParams(params);
      targets = [{ label: paramsPath, params }];
    } catch (e) {
      io.err(`bad parameters (${paramsPath}): ${(e as Error).message}`);
      return 2;
    }
  } else {
    targets = file.positions.map((p) => ({ label: `${p.strategyName ?? "position"} (${p.positionId})`, params: p.params }));
  }
  let body: unknown;
  let installed: InstalledPolicy[];
  try {
    body = await fetchInstalledPolicies({ organizationId: file.organizationId, privateKeyHex: file.apiPrivateKey, publicKeyHex: file.apiPublicKey, fetchImpl: io.fetch });
    installed = parsePolicyExport(body);
  } catch (e) {
    const expired = file.expiresAt && Date.parse(file.expiresAt) < Date.now()
      ? ` (the key expired on ${file.expiresAt.slice(0, 10)}; create a new one at ${VERIFY_PAGE_URL})` : "";
    io.err(`could not fetch the policies from Turnkey: ${(e as Error).message}${expired}`);
    return 2;
  }
  const savePath = opt("--save");
  if (savePath) (io.write ?? writeFileSync)(savePath, JSON.stringify(body, null, 2) + "\n");

  const deny = checkVerificationDeny(installed, file.apiPublicKey);
  const results: Array<{ label: string; result: VerifyResult | null }> =
    targets.map((t) => ({ label: t.label, result: t.params ? verifyPosition(t.params, installed) : null }));
  const missing = results.filter((r) => !r.result).length;
  const failed = deny.status === "fail" || results.some((r) => r.result && !r.result.ok);
  const superseded = results.some((r) => r.result?.superseded);
  if (argv.includes("--json")) {
    io.out(JSON.stringify({ ok: !failed && missing === 0, organizationId: file.organizationId, verificationKey: deny, positions: results }, null, 2));
  } else {
    const lines = [`${deny.status === "pass" ? "PASS" : "FAIL"}  ${deny.message}`, ""];
    if (results.length === 0) lines.push("No Tax Alpha positions are listed in the key file (and no --params was given).", "");
    for (const r of results) {
      lines.push(`── ${r.label}`);
      lines.push(r.result ? formatResult(r.result) : "SKIP  Darwin could not reproduce this position's parameters; pass them with --params <position.json>", "");
    }
    io.out(lines.join("\n").trimEnd());
  }
  // A failed check wins; then a position that could not be checked; then a superseded ALLOW.
  return failed ? 1 : missing > 0 ? 2 : superseded ? 3 : 0;
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s), read: (p) => readFileSync(p, "utf8"), env: process.env }));
}
