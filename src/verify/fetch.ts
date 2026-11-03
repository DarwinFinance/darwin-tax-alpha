/**
 * Fetch a sub-organization's installed policies straight from Turnkey, with the user's OWN API key.
 *
 * This is the "advanced" path in the README: no Darwin server or page is involved. The request is Turnkey's
 * read-only `list_policies` query, sent to api.turnkey.com and signed ("stamped") with a P-256 API key the
 * user holds on their own sub-organization. A query changes nothing, and a user with an API key but no ALLOW
 * policy can run queries and nothing else.
 *
 * The private key is read from the environment by the CLI, used to sign one request body, and never printed,
 * logged, written to disk or sent anywhere: only the signature and the PUBLIC key leave this process, in the
 * `X-Stamp` header Turnkey requires.
 */
import { ECDH, createECDH, createPrivateKey, createSign } from "node:crypto";

/** The only host this module ever sends a request to. */
export const TURNKEY_API_ORIGIN = "https://api.turnkey.com";
export const LIST_POLICIES_PATH = "/public/v1/query/list_policies";

/** Env var names the CLI reads (dedicated names, so a server key in a shell is never picked up by accident). */
export const ENV_PRIVATE_KEY = "TURNKEY_READONLY_API_PRIVATE_KEY";
export const ENV_PUBLIC_KEY = "TURNKEY_READONLY_API_PUBLIC_KEY";

const HEX = /^[0-9a-fA-F]+$/;
const ORG_ID = /^[A-Za-z0-9-]{8,64}$/;
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The compressed public key (hex) of a Turnkey API private key (hex). Throws without echoing the key. */
export function publicKeyOf(privateKeyHex: string): string {
  if (!HEX.test(privateKeyHex) || privateKeyHex.length > 64) throw new Error("the API private key must be hex (a Turnkey P-256 API key)");
  const ecdh = createECDH("prime256v1");
  try {
    ecdh.setPrivateKey(Buffer.from(privateKeyHex.padStart(64, "0"), "hex"));
  } catch {
    throw new Error("the API private key is not a valid P-256 key");
  }
  return ecdh.getPublicKey("hex", "compressed");
}

/**
 * Turnkey's API-key stamp for a request body: base64url(JSON { publicKey, scheme, signature }), where the
 * signature is ECDSA P-256 / SHA-256 over the exact body bytes, DER-encoded, in hex (as @turnkey/api-key-stamper).
 */
export function turnkeyStamp(body: string, privateKeyHex: string, publicKeyHex?: string): string {
  const derived = publicKeyOf(privateKeyHex);
  if (publicKeyHex !== undefined && publicKeyHex.toLowerCase() !== derived) {
    throw new Error(`${ENV_PUBLIC_KEY} does not belong to ${ENV_PRIVATE_KEY}`);
  }
  const point = Buffer.from(ECDH.convertKey(derived, "prime256v1", "hex", "hex", "uncompressed") as string, "hex");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64url(Buffer.from(privateKeyHex.padStart(64, "0"), "hex")), x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) },
    format: "jwk",
  });
  const signer = createSign("SHA256");
  signer.update(Buffer.from(body, "utf8"));
  signer.end();
  const signature = signer.sign(key, "hex");
  return b64url(Buffer.from(JSON.stringify({ publicKey: derived, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature }), "utf8"));
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "error" }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * POST list_policies for `organizationId` to api.turnkey.com, stamped with the user's key. Returns Turnkey's
 * parsed JSON response unmodified (the same shape `parsePolicyExport` reads).
 */
export async function fetchInstalledPolicies(args: { organizationId: string; privateKeyHex: string; publicKeyHex?: string; fetchImpl?: FetchLike }): Promise<unknown> {
  if (!ORG_ID.test(args.organizationId)) throw new Error("the sub-organization id must look like a Turnkey organization id");
  const body = JSON.stringify({ organizationId: args.organizationId });
  const stamp = turnkeyStamp(body, args.privateKeyHex, args.publicKeyHex);
  const doFetch = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const res = await doFetch(`${TURNKEY_API_ORIGIN}${LIST_POLICIES_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Stamp": stamp },
    body,
    redirect: "error", // never follow a redirect away from api.turnkey.com
  });
  const text = await res.text();
  if (!res.ok) {
    let message = "";
    try { message = String((JSON.parse(text) as { message?: unknown }).message ?? ""); } catch { /* not JSON */ }
    throw new Error(`Turnkey refused list_policies (HTTP ${res.status})${message ? `: ${message.slice(0, 300)}` : ""}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Turnkey's response was not JSON");
  }
}
