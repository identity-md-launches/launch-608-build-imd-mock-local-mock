// EIP-712 typed-data hashing for the subset of types the IMD flow uses:
// string, address, bool, uintN, bytes32 and nested structs.
import { bigIntToBytes, bytesToHex, concatBytes, hexToBytes, isAddress, isBytes32 } from "./hex.js";
import { keccak256 } from "./keccak.js";
import { recoverAddress, signHash } from "./secp256k1.js";
const DOMAIN_FIELDS = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
];
const utf8 = (s) => new TextEncoder().encode(s);
function dependencies(primary, types, found = new Set()) {
    if (found.has(primary) || !types[primary])
        return found;
    found.add(primary);
    for (const field of types[primary])
        dependencies(field.type, types, found);
    return found;
}
export function encodeType(primary, types) {
    const deps = [...dependencies(primary, types)].filter((t) => t !== primary).sort();
    return [primary, ...deps]
        .map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(",")})`)
        .join("");
}
export function typeHash(primary, types) {
    return keccak256(utf8(encodeType(primary, types)));
}
function toUint(value, bits, field) {
    let n;
    if (typeof value === "bigint")
        n = value;
    else if (typeof value === "number" && Number.isSafeInteger(value))
        n = BigInt(value);
    else if (typeof value === "string" && /^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value))
        n = BigInt(value);
    else
        throw new Error(`${field}: expected uint${bits}`);
    if (n < 0n || n >= 1n << BigInt(bits))
        throw new Error(`${field}: out of range for uint${bits}`);
    return n;
}
function encodeValue(type, value, types, field) {
    if (types[type]) {
        if (typeof value !== "object" || value === null)
            throw new Error(`${field}: expected ${type} struct`);
        return hashStruct(type, value, types);
    }
    if (type === "string") {
        if (typeof value !== "string")
            throw new Error(`${field}: expected string`);
        return keccak256(utf8(value));
    }
    if (type === "address") {
        if (!isAddress(value))
            throw new Error(`${field}: expected address`);
        return concatBytes(new Uint8Array(12), hexToBytes(value));
    }
    if (type === "bytes32") {
        if (!isBytes32(value))
            throw new Error(`${field}: expected bytes32`);
        return hexToBytes(value);
    }
    if (type === "bool") {
        if (typeof value !== "boolean")
            throw new Error(`${field}: expected bool`);
        return bigIntToBytes(value ? 1n : 0n);
    }
    const uint = /^uint(\d+)$/.exec(type);
    if (uint)
        return bigIntToBytes(toUint(value, Number(uint[1]), field));
    throw new Error(`${field}: unsupported EIP-712 type ${type}`);
}
export function hashStruct(primary, data, types) {
    const fields = types[primary];
    if (!fields)
        throw new Error(`unknown type ${primary}`);
    const encoded = fields.map((f) => encodeValue(f.type, data[f.name], types, `${primary}.${f.name}`));
    return keccak256(concatBytes(typeHash(primary, types), ...encoded));
}
export function domainFields(domain) {
    return DOMAIN_FIELDS.filter((f) => domain[f.name] !== undefined);
}
export function hashDomain(domain) {
    return hashStruct("EIP712Domain", domain, { EIP712Domain: domainFields(domain) });
}
export function hashTypedData(data) {
    return keccak256(concatBytes(Uint8Array.of(0x19, 0x01), hashDomain(data.domain), hashStruct(data.primaryType, data.message, data.types)));
}
export function hashTypedDataHex(data) {
    return bytesToHex(hashTypedData(data));
}
export function signTypedData(data, privateKey) {
    return signHash(hashTypedData(data), privateKey);
}
export function recoverTypedDataAddress(data, signature) {
    return recoverAddress(hashTypedData(data), signature);
}
