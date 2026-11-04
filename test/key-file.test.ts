import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createECDH } from "node:crypto";
import { runCli, type CliIo } from "../src/verify";
import { checkVerificationDeny, expectedVerificationDeny, parseKeyFile, KEY_FILE_FORMAT } from "../src/verify/key-file";

const vec = (p: string) => readFileSync(join(import.meta.dir, "vectors", p), "utf8");
const ORG = "11111111-2222-4333-8444-555555555555";

// A throwaway P-256 key generated for this test run only.
function testKey() {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { priv: e.getPrivateKey("hex").padStart(64, "0"), pub: e.getPublicKey("hex", "compressed") };
}

function keyFile(k: { priv: string; pub: string }, extra: Record<string, unknown> = {}) {
  return {
    format: KEY_FILE_FORMAT, organizationId: ORG, apiPublicKey: k.pub, apiPrivateKey: k.priv,
    turnkeyUserId: "v1", turnkeyUserName: "darwin-verification-20261104-abc123",
    createdAt: "2026-11-04T12:00:00.000Z", expiresAt: "2099-02-02T12:00:00.000Z", turnkeyApiBaseUrl: "https://api.turnkey.com",
    positions: [{ positionId: "p1", strategyName: "Vector A", authoredGeneration: "s3-dflow-accounts-bound", params: JSON.parse(vec("position-a.params.json")) }],
    ...extra,
  };
}

/** Turnkey's list_policies answer: position A's policies, plus (optionally) the key's read-only DENY. */
function exportWith(pub: string, deny = true) {
  const body = JSON.parse(vec("position-a.export.json"));
  if (deny) body.policies.push({ policyId: "d1", policyName: "verification-key-deny-x", ...expectedVerificationDeny(pub), notes: "" });
  return JSON.stringify(body);
}

async function run(argv: string[], file: unknown, policies: string, extra: Partial<CliIo> = {}) {
  let out = "", err = "";
  const seen: { url: string; body: string }[] = [];
  const code = await runCli(argv, {
    out: (s) => { out += s + "\n"; },
    err: (s) => { err += s + "\n"; },
    read: (p) => (p === "key.json" ? JSON.stringify(file) : vec(p)),
    env: {},
    fetch: async (url, init) => { seen.push({ url, body: init.body }); return { ok: true, status: 200, text: async () => policies }; },
    ...extra,
  });
  return { code, out, err, seen };
}

describe("--key <verification key file>", () => {
  it("fetches with the file's key, confirms the key is read-only, verifies every position: exit 0", async () => {
    const k = testKey();
    const r = await run(["--key", "key.json"], keyFile(k), exportWith(k.pub));
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS  this verification key is read-only");
    expect(r.out).toContain("── Vector A (p1)");
    expect(r.out).toContain("RESULT: PASS");
    expect(r.seen).toEqual([{ url: "https://api.turnkey.com/public/v1/query/list_policies", body: JSON.stringify({ organizationId: ORG }) }]);
    for (const t of [r.out, r.err, JSON.stringify(r.seen)]) expect(t).not.toContain(k.priv);
  });

  it("exits 1 when the key's read-only DENY is not installed", async () => {
    const k = testKey();
    const r = await run(["--key", "key.json"], keyFile(k), exportWith(k.pub, false));
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL  this verification key's read-only DENY policy is NOT installed");
  });

  it("exits 2 (and says so) for a position whose parameters Darwin could not reproduce; --params fills it in", async () => {
    const k = testKey();
    const file = keyFile(k, { positions: [{ positionId: "p9", strategyName: "Vector A", params: null }] });
    const r = await run(["--key", "key.json"], file, exportWith(k.pub));
    expect(r.code).toBe(2);
    expect(r.out).toContain("SKIP");
    const withParams = await run(["--key", "key.json", "--params", "position-a.params.json"], file, exportWith(k.pub));
    expect(withParams.code).toBe(0);
  });

  it("--json is machine-readable", async () => {
    const k = testKey();
    const r = await run(["--key", "key.json", "--json"], keyFile(k), exportWith(k.pub));
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(true);
    expect(j.verificationKey.status).toBe("pass");
    expect(j.positions[0].result.ok).toBe(true);
  });

  it("refuses a bad file without sending anything, and never echoes the private key", async () => {
    const k = testKey();
    const never: Partial<CliIo> = { fetch: async () => { throw new Error("must not be called"); } };
    for (const bad of [
      { ...keyFile(k), format: "something-else" },
      { ...keyFile(k), turnkeyApiBaseUrl: "https://evil.example" },
      { ...keyFile(k), apiPublicKey: testKey().pub },
      { ...keyFile(k), apiPrivateKey: "zz" },
      { ...keyFile(k), organizationId: "x' || '" },
    ]) {
      const r = await run(["--key", "key.json"], bad, "", never);
      expect(r.code).toBe(2);
      expect(r.err).not.toContain(k.priv);
    }
    expect((await run(["--key", "key.json", "--export", "position-a.export.json"], keyFile(k), "", never)).code).toBe(2);
    expect((await run(["--key", "key.json", "--organization", "22222222-2222-4333-8444-555555555555"], keyFile(k), "", never)).code).toBe(2);
    expect((await run(["--key"], keyFile(k), "", never)).code).toBe(2);
  });

  it("a refused request (an expired or revoked key) exits 2 with Turnkey's status", async () => {
    const k = testKey();
    const r = await run(["--key", "key.json"], keyFile(k, { expiresAt: "2020-01-01T00:00:00.000Z" }), "", { fetch: async () => ({ ok: false, status: 401, text: async () => "{}" }) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("HTTP 401");
    expect(r.err).toContain("the key expired on 2020-01-01");
  });
});

describe("key-file", () => {
  it("the expected DENY names exactly this key and refuses everything", () => {
    const k = testKey();
    expect(expectedVerificationDeny(k.pub)).toEqual({ effect: "EFFECT_DENY", consensus: `credentials.any(credential, credential.public_key == '${k.pub}')`, condition: "true" });
    expect(() => expectedVerificationDeny("02zz")).toThrow();
    const other = testKey();
    expect(checkVerificationDeny([{ ...expectedVerificationDeny(other.pub) }], k.pub).status).toBe("fail");
    expect(checkVerificationDeny([{ ...expectedVerificationDeny(k.pub), condition: "false" }], k.pub).status).toBe("fail");
  });

  it("parseKeyFile keeps positions and their params", () => {
    const k = testKey();
    const f = parseKeyFile(keyFile(k));
    expect(f.organizationId).toBe(ORG);
    expect(f.positions[0]!.params?.strategyUserId).toBe(JSON.parse(vec("position-a.params.json")).strategyUserId);
  });
});
