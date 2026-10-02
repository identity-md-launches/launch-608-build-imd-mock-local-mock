import { keccak256 } from "./keccak.js";
export function bytesToHex(bytes) {
    return `0x${Buffer.from(bytes).toString("hex")}`;
}
export function hexToBytes(hex) {
    const body = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
        throw new Error(`not a hex string: ${hex}`);
    }
    return new Uint8Array(Buffer.from(body, "hex"));
}
export function bytesToBigInt(bytes) {
    return bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes));
}
export function bigIntToBytes(value, length = 32) {
    if (value < 0n)
        throw new Error("negative value");
    const hex = value.toString(16).padStart(length * 2, "0");
    if (hex.length > length * 2)
        throw new Error(`value does not fit in ${length} bytes`);
    return hexToBytes(hex);
}
export function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
export function isAddress(value) {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}
export function isBytes32(value) {
    return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}
/** EIP-55 mixed-case checksum encoding. */
export function toChecksumAddress(address) {
    if (!isAddress(address))
        throw new Error(`not an address: ${address}`);
    const lower = address.slice(2).toLowerCase();
    const hash = Buffer.from(keccak256(new TextEncoder().encode(lower))).toString("hex");
    let out = "0x";
    for (let i = 0; i < 40; i++) {
        out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
    }
    return out;
}
export function sameAddress(a, b) {
    return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}
