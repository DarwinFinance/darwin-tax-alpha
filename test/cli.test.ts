import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/verify";

function run(argv: string[]) {
  let out = "", err = "";
  const code = runCli(argv, {
    out: (s) => { out += s + "\n"; },
    err: (s) => { err += s + "\n"; },
    read: (p) => readFileSync(join(import.meta.dir, "vectors", p), "utf8"),
  });
  return { code, out, err };
}

describe("darwin-tax-alpha-verify", () => {
  it("exits 0 with RESULT: PASS on a matching export", () => {
    const r = run(["--params", "position-a.params.json", "--export", "position-a.export.json"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESULT: PASS");
  });

  it("exits 1 with RESULT: FAIL on a tampered export", () => {
    const r = run(["--params", "position-b.params.json", "--export", "position-b.export.json"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("RESULT: FAIL");
    expect(r.out).toContain("first difference at character");
  });

  it("--json emits a machine-readable result", () => {
    const r = run(["--params", "position-a.params.json", "--export", "position-a.export.json", "--json"]);
    expect(JSON.parse(r.out).ok).toBe(true);
  });

  it("--print-expected prints the rendered policies", () => {
    const r = run(["--params", "position-a.params.json", "--print-expected"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(JSON.parse(readFileSync(join(import.meta.dir, "vectors", "position-a.expected.json"), "utf8")));
  });

  it("exits 2 on bad input", () => {
    expect(run([]).code).toBe(2);
    expect(run(["--params", "position-a.params.json"]).code).toBe(2);
    expect(run(["--params", "position-a.export.json", "--export", "position-a.export.json"]).code).toBe(2);
    expect(run(["--params", "position-a.params.json", "--export", "position-a.params.json"]).code).toBe(2);
  });
});
