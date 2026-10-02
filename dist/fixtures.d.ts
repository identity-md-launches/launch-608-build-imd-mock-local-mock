import { type Hex } from "./crypto/hex.js";
/** keccak256("imd-mock/payer/<i>"): private keys for test payers. */
export declare function testPayerKey(index?: number): Hex;
/** sha256("imd-mock/bearer/<i>") as hex: test bearer tokens (32 bytes, hex). */
export declare function testBearerToken(index?: number): string;
/**
 * The mock's payTo: the address of keccak256("imd-mock/payTo"), lowercase as
 * the quote schema requires. Not the real IMD payTo.
 */
export declare const MOCK_PAY_TO: Hex;
export declare const TEST_PAYER_KEY: Hex;
export declare const TEST_PAYER_ADDRESS: Hex;
export declare const TEST_BEARER_TOKEN: string;
/** Fixed clock (2026-01-01T00:00:00Z) used for the committed vectors. */
export declare const FIXED_NOW_MS: number;
/** Fixed permit nonce used for the committed vectors. Real clients use 32 random bytes. */
export declare const FIXED_NONCE: string;
export declare const FIXED_REQUEST_KEY = "00000000-0000-4000-8000-000000000001";
/** The job.open body the committed vectors are built from. */
export declare const FIXED_JOB_INPUT: {
    objective: string;
    skill: string;
    outputs: {
        name: string;
        path: string;
        mediaType: string;
    }[];
    minCitations: number;
    github: boolean;
};
