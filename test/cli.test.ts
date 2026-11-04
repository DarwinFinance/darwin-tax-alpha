import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createECDH, createPublicKey, createVerify, ECDH } from "node:crypto";
import { runCli, turnkeyStamp, publicKeyOf, type CliIo } from "../src/verify";

async function run(argv: string[], extra: Partial<CliIo> = {}) {
  let out = "", err = "";
  const code = await runCli(argv, {
    out: (s) => { out += s + "\n"; },
    err: (s) => { err += s + "\n"; },
    read: (p) => readFileSync(join(import.meta.dir, "vectors", p), "utf8"),
    ...extra,
  });
  return { code, out, err };
}

describe("darwin-tax-alpha-verify", () => {
  it("exits 0 with RESULT: PASS on a matching export", async () => {
    const r = await run(["--params", "position-a.params.json", "--export", "position-a.export.json"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESULT: PASS");
  });

  it("exits 1 with RESULT: FAIL on a tampered export", async () => {
    const r = await run(["--params", "position-b.params.json", "--export", "position-b.export.json"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("RESULT: FAIL");
    expect(r.out).toContain("first difference at character");
  });

  it("exits 3 with RESULT: WARNING on a superseded (s1) export", async () => {
    const r = await run(["--params", "position-c.params.json", "--export", "position-c.export.json"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("RESULT: WARNING — s1: superseded, missing the relay-close bound and the dFlow wrap_sol/ATA-owner bounds; run the Security update in Darwin");
  });

  it("exits 3 with RESULT: WARNING on a superseded (s2) export", async () => {
    const r = await run(["--params", "position-d.params.json", "--export", "position-d.export.json"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("WARN  ALLOW policy 'tax-alpha-allow-enr_vectorD01' — s2: superseded, missing the dFlow wrap_sol/ATA-owner bounds; run the Security update in Darwin");
    expect(r.out).toContain("RESULT: WARNING — s2: superseded, missing the dFlow wrap_sol/ATA-owner bounds; run the Security update in Darwin");
  });

  it("--json emits a machine-readable result", async () => {
    const r = await run(["--params", "position-a.params.json", "--export", "position-a.export.json", "--json"]);
    expect(JSON.parse(r.out).ok).toBe(true);
  });

  it("--print-expected prints the rendered policies", async () => {
    const r = await run(["--params", "position-a.params.json", "--print-expected"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(JSON.parse(readFileSync(join(import.meta.dir, "vectors", "position-a.expected.json"), "utf8")));
  });

  it("exits 2 on bad input", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["--params", "position-a.params.json"])).code).toBe(2);
    expect((await run(["--params", "position-a.export.json", "--export", "position-a.export.json"])).code).toBe(2);
    expect((await run(["--params", "position-a.params.json", "--export", "position-a.params.json"])).code).toBe(2);
  });
});

// A throwaway P-256 key generated for this test run only.
function testKey() {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { priv: e.getPrivateKey("hex"), pub: e.getPublicKey("hex", "compressed") };
}
const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

describe("--fetch (your own Turnkey API key, straight to api.turnkey.com)", () => {
  it("the stamp is Turnkey's format and verifies against the public key, over the exact body", () => {
    const { priv, pub } = testKey();
    expect(publicKeyOf(priv)).toBe(pub);
    const body = JSON.stringify({ organizationId: "11111111-2222-4333-8444-555555555555" });
    const stamp = JSON.parse(b64urlDecode(turnkeyStamp(body, priv)).toString("utf8"));
    expect(stamp.publicKey).toBe(pub);
    expect(stamp.scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
    const point = Buffer.from(ECDH.convertKey(pub, "prime256v1", "hex", "hex", "uncompressed") as string, "hex");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
    const v = createVerify("SHA256"); v.update(body); v.end();
    expect(v.verify(key, Buffer.from(stamp.signature, "hex"))).toBe(true);
    expect(() => turnkeyStamp(body, priv, testKey().pub)).toThrow();
  });

  it("POSTs list_policies to api.turnkey.com only, verifies the response, saves it, and never prints the key", async () => {
    const { priv } = testKey();
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    let saved = "";
    const exportBody = readFileSync(join(import.meta.dir, "vectors", "position-a.export.json"), "utf8");
    const r = await run(["--params", "position-a.params.json", "--fetch", "--organization", "11111111-2222-4333-8444-555555555555", "--save", "out.json"], {
      env: { TURNKEY_READONLY_API_PRIVATE_KEY: priv },
      fetch: async (url, init) => { seen.push({ url, headers: init.headers, body: init.body }); return { ok: true, status: 200, text: async () => exportBody }; },
      write: (_p, s) => { saved = s; },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESULT: PASS");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.turnkey.com/public/v1/query/list_policies");
    expect(JSON.parse(seen[0]!.body)).toEqual({ organizationId: "11111111-2222-4333-8444-555555555555" });
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(["Content-Type", "X-Stamp"]);
    expect(JSON.parse(saved)).toEqual(JSON.parse(exportBody));
    for (const text of [r.out, r.err, saved, JSON.stringify(seen)]) expect(text).not.toContain(priv);
  });

  it("fails as bad input without a key, with a refused request, or with a malformed organization id — still never printing the key", async () => {
    const { priv } = testKey();
    const args = ["--params", "position-a.params.json", "--fetch", "--organization", "11111111-2222-4333-8444-555555555555"];
    expect((await run(args, { env: {} })).code).toBe(2);
    const refused = await run(args, { env: { TURNKEY_READONLY_API_PRIVATE_KEY: priv }, fetch: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: "unauthenticated" }) }) });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("HTTP 401");
    expect(refused.err).not.toContain(priv);
    const badOrg = await run(["--params", "position-a.params.json", "--fetch", "--organization", "x' || '"], { env: { TURNKEY_READONLY_API_PRIVATE_KEY: priv }, fetch: async () => { throw new Error("must not be called"); } });
    expect(badOrg.code).toBe(2);
    const badKey = await run(args, { env: { TURNKEY_READONLY_API_PRIVATE_KEY: "zz-not-hex" }, fetch: async () => { throw new Error("must not be called"); } });
    expect(badKey.code).toBe(2);
    expect(badKey.err).not.toContain("zz-not-hex");
  });
});
