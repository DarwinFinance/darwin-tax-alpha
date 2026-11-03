#!/usr/bin/env bun
/**
 * darwin-tax-alpha-verify — check a Tax Alpha position's installed Turnkey permissions.
 *
 *   bun src/verify/cli.ts --params position.json --export policies.json [--json]
 *   bun src/verify/cli.ts --params position.json --fetch --organization <sub-org id> [--save policies.json] [--json]
 *   bun src/verify/cli.ts --params position.json --print-expected
 *
 * --fetch reads the policies straight from api.turnkey.com with YOUR OWN Turnkey API key, taken from the
 * environment (TURNKEY_READONLY_API_PRIVATE_KEY, optionally TURNKEY_READONLY_API_PUBLIC_KEY). The key is
 * never printed or saved. See src/verify/fetch.ts.
 *
 * Exit codes: 0 pass, 1 mismatch, 2 bad input, 3 superseded (the s1 ALLOW is installed; nothing else differs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { expectedPositionPolicies, validatePositionParams } from "../permissions/position";
import { parsePolicyExport } from "./export";
import { ENV_PRIVATE_KEY, ENV_PUBLIC_KEY, fetchInstalledPolicies, type FetchLike } from "./fetch";
import { formatResult, verifyPosition } from "./verify";

const USAGE = `usage:
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

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s), read: (p) => readFileSync(p, "utf8"), env: process.env }));
}
