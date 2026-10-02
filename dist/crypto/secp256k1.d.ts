import { type Hex } from "./hex.js";
export declare function privateKeyToAddress(privateKey: Hex): Hex;
/**
 * Sign a 32-byte digest. Returns the 65-byte Ethereum signature r || s || v
 * with low s and v in {27, 28}.
 */
export declare function signHash(hash: Uint8Array, privateKey: Hex): Hex;
/**
 * Recover the signer address of a 65-byte signature over a 32-byte digest.
 * Accepts v as 0/1 or 27/28. Throws on any malformed or invalid signature.
 */
export declare function recoverAddress(hash: Uint8Array, signature: string): Hex;
