export type Hex = `0x${string}`;
export declare function bytesToHex(bytes: Uint8Array): Hex;
export declare function hexToBytes(hex: string): Uint8Array;
export declare function bytesToBigInt(bytes: Uint8Array): bigint;
export declare function bigIntToBytes(value: bigint, length?: number): Uint8Array;
export declare function concatBytes(...parts: Uint8Array[]): Uint8Array;
export declare function isAddress(value: unknown): value is string;
export declare function isBytes32(value: unknown): value is string;
/** EIP-55 mixed-case checksum encoding. */
export declare function toChecksumAddress(address: string): Hex;
export declare function sameAddress(a: unknown, b: unknown): boolean;
