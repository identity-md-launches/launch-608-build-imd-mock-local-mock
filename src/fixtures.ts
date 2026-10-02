// Deterministic test identities. Every key here is public: derived from a
// fixed label, printed in the README and committed in fixtures/. Never send
// funds to these addresses on a real chain.

import { bytesToHex, type Hex } from "./crypto/hex.js";
import { keccak256 } from "./crypto/keccak.js";
import { privateKeyToAddress } from "./crypto/secp256k1.js";
import { sha256Hex } from "./protocol.js";

const label = (s: string) => new TextEncoder().encode(s);

/** keccak256("imd-mock/payer/<i>"): private keys for test payers. */
export function testPayerKey(index = 0): Hex {
  return bytesToHex(keccak256(label(`imd-mock/payer/${index}`)));
}

/** sha256("imd-mock/bearer/<i>") as hex: test bearer tokens (32 bytes, hex). */
export function testBearerToken(index = 0): string {
  return sha256Hex(`imd-mock/bearer/${index}`);
}

/**
 * The mock's payTo: the address of keccak256("imd-mock/payTo"), lowercase as
 * the quote schema requires. Not the real IMD payTo.
 */
export const MOCK_PAY_TO = privateKeyToAddress(bytesToHex(keccak256(label("imd-mock/payTo")))).toLowerCase() as Hex;

export const TEST_PAYER_KEY: Hex = testPayerKey(0);
export const TEST_PAYER_ADDRESS: Hex = privateKeyToAddress(TEST_PAYER_KEY);
export const TEST_BEARER_TOKEN: string = testBearerToken(0);

/** Fixed clock (2026-01-01T00:00:00Z) used for the committed vectors. */
export const FIXED_NOW_MS = Date.UTC(2026, 0, 1);
/** Fixed permit nonce used for the committed vectors. Real clients use 32 random bytes. */
export const FIXED_NONCE = BigInt(bytesToHex(keccak256(label("imd-mock/nonce/0")))).toString(10);
export const FIXED_REQUEST_KEY = "00000000-0000-4000-8000-000000000001";

/** The job.open body the committed vectors are built from. */
export const FIXED_JOB_INPUT = {
  objective: "Write a sourced report comparing three approaches to deterministic EVM testing.",
  skill: "research-report",
  outputs: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown" }],
  minCitations: 5,
  github: false,
};
