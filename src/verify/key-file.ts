/**
 * The read-only verification key file Darwin's verification page saves in your browser
 * (`darwin-verification-key-<date>.json`, format `darwin-tax-alpha-verification-key/v1`).
 *
 * The page creates, with one passkey approval per step, in YOUR Turnkey sub-organization:
 *   1. a DENY policy whose consensus names the new key's public key and whose condition is `true`, so Turnkey
 *      refuses EVERY activity that key submits (signing, sending, exporting, approving, adding keys or passkeys,
 *      including to itself). It is installed before the key exists.
 *   2. a non-root user holding the key, expiring after 90 days, plus one "anchor" key whose private key no one
 *      holds (Turnkey refuses a user whose only credential expires). The anchor's public key is a
 *      nothing-up-my-sleeve point: the first `02 || SHA-256("darwin-verification-anchor-v1:<user name>:<i>")`
 *      that is a valid P-256 point.
 *
 * A key with no ALLOW and that DENY can run Turnkey QUERIES (list_policies, whoami, list_wallets), which is all
 * the verifier needs. This module reads the file and checks, from the policies it fetched, that the DENY is
 * installed exactly — so the verifier itself confirms the key is read-only.
 *
 * The private key in the file is read into memory, used to sign the one list_policies request, and never
 * printed, logged or written anywhere.
 */
import type { PositionParams } from "../permissions/position";
import { validatePositionParams } from "../permissions/position";
import type { InstalledPolicy } from "./export";
import type { Check } from "./verify";
import { publicKeyOf, TURNKEY_API_ORIGIN } from "./fetch";

export const KEY_FILE_FORMAT = "darwin-tax-alpha-verification-key/v1";

export interface KeyFilePosition {
  positionId: string;
  strategyName?: string;
  authoredGeneration?: string | null;
  /** null when Darwin could not reproduce the position's parameters from what it installed. */
  params: PositionParams | null;
}

export interface VerificationKeyFile {
  organizationId: string;
  apiPublicKey: string;
  /** Hex. Never printed. */
  apiPrivateKey: string;
  turnkeyUserId?: string;
  turnkeyUserName?: string;
  createdAt?: string;
  expiresAt?: string;
  createdOn?: string;
  positions: KeyFilePosition[];
}

const ORG_ID = /^[A-Za-z0-9-]{8,64}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const COMPRESSED = /^0[23][0-9a-f]{64}$/;

/** Parse and check a key file. Errors never contain the private key. */
export function parseKeyFile(json: unknown): VerificationKeyFile {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("not a verification key file");
  const o = json as Record<string, unknown>;
  if (o.format !== KEY_FILE_FORMAT) throw new Error(`not a verification key file (expected format "${KEY_FILE_FORMAT}")`);
  if (o.turnkeyApiBaseUrl !== undefined && o.turnkeyApiBaseUrl !== TURNKEY_API_ORIGIN) {
    throw new Error(`the key file names an API host other than ${TURNKEY_API_ORIGIN}; refusing to use it`);
  }
  if (typeof o.organizationId !== "string" || !ORG_ID.test(o.organizationId)) throw new Error("the key file's organizationId is not a Turnkey organization id");
  if (typeof o.apiPublicKey !== "string" || !COMPRESSED.test(o.apiPublicKey)) throw new Error("the key file's apiPublicKey is not a compressed P-256 key");
  if (typeof o.apiPrivateKey !== "string" || !HEX64.test(o.apiPrivateKey)) throw new Error("the key file's apiPrivateKey is not a 32-byte hex key");
  let derived: string;
  try { derived = publicKeyOf(o.apiPrivateKey); } catch { throw new Error("the key file's apiPrivateKey is not a valid P-256 key"); }
  if (derived !== o.apiPublicKey) throw new Error("the key file's apiPrivateKey does not belong to its apiPublicKey");
  const positions: KeyFilePosition[] = [];
  const raw = Array.isArray(o.positions) ? o.positions : [];
  raw.forEach((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`positions[${i}] is not an object`);
    const q = p as Record<string, unknown>;
    let params: PositionParams | null = null;
    if (q.params !== null && q.params !== undefined) {
      try { validatePositionParams(q.params); } catch (e) { throw new Error(`positions[${i}].params: ${(e as Error).message}`); }
      params = q.params as PositionParams;
    }
    positions.push({
      positionId: typeof q.positionId === "string" ? q.positionId : `#${i + 1}`,
      strategyName: typeof q.strategyName === "string" ? q.strategyName : undefined,
      authoredGeneration: typeof q.authoredGeneration === "string" ? q.authoredGeneration : null,
      params,
    });
  });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    organizationId: o.organizationId, apiPublicKey: o.apiPublicKey, apiPrivateKey: o.apiPrivateKey,
    turnkeyUserId: str(o.turnkeyUserId), turnkeyUserName: str(o.turnkeyUserName), createdAt: str(o.createdAt),
    expiresAt: str(o.expiresAt), createdOn: str(o.createdOn), positions,
  };
}

/** The DENY that makes the key read-only, exactly as Darwin's page installs it. */
export function expectedVerificationDeny(publicKey: string): { effect: "EFFECT_DENY"; consensus: string; condition: string } {
  if (!COMPRESSED.test(publicKey)) throw new Error("not a compressed P-256 public key");
  return { effect: "EFFECT_DENY", consensus: `credentials.any(credential, credential.public_key == '${publicKey}')`, condition: "true" };
}

/** PASS when the read-only DENY for this key is installed byte for byte, FAIL otherwise. */
export function checkVerificationDeny(installed: InstalledPolicy[], publicKey: string): Check {
  const want = expectedVerificationDeny(publicKey);
  const found = installed.some((p) => p.effect === want.effect && p.consensus === want.consensus && p.condition === want.condition);
  return found
    ? { id: "verification-key-deny", status: "pass", message: "this verification key is read-only: its DENY policy is installed exactly (every activity it submits is refused)" }
    : { id: "verification-key-deny", status: "fail", message: "this verification key's read-only DENY policy is NOT installed; revoke the key in Darwin and create a new one" };
}
