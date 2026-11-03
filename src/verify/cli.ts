#!/usr/bin/env bun
/**
 * darwin-tax-alpha-verify — check a Tax Alpha position's installed Turnkey permissions.
 *
 *   bun src/verify/cli.ts --params position.json --export policies.json [--json]
 *   bun src/verify/cli.ts --params position.json --print-expected
 *
 * Exit codes: 0 pass, 1 mismatch, 2 bad input.
 */
import { readFileSync } from "node:fs";
import { expectedPositionPolicies, validatePositionParams } from "../permissions/position";
import { parsePolicyExport } from "./export";
import { formatResult, verifyPosition } from "./verify";

const USAGE = `usage:
  darwin-tax-alpha-verify --params <position.json> --export <turnkey-policies.json> [--json]
  darwin-tax-alpha-verify --params <position.json> --print-expected`;

export function runCli(argv: string[], io: { out: (s: string) => void; err: (s: string) => void; read: (p: string) => string }): number {
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
  if (!exportPath) { io.err(USAGE); return 2; }
  let installed;
  try {
    installed = parsePolicyExport(JSON.parse(io.read(exportPath)));
  } catch (e) {
    io.err(`bad policy export (${exportPath}): ${(e as Error).message}`);
    return 2;
  }
  const result = verifyPosition(params, installed);
  io.out(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatResult(result));
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s), read: (p) => readFileSync(p, "utf8") }));
}
