// EIP-712 typed-data hashing for the subset of types the IMD flow uses:
// string, address, bool, uintN, bytes32 and nested structs.

import { bigIntToBytes, bytesToHex, concatBytes, hexToBytes, isAddress, isBytes32, type Hex } from "./hex.js";
import { keccak256 } from "./keccak.js";
import { recoverAddress, signHash } from "./secp256k1.js";

export type TypedField = { name: string; type: string };
export type TypedDataTypes = Record<string, TypedField[]>;

export interface TypedData {
  domain: Record<string, unknown>;
  types: TypedDataTypes; // without EIP712Domain; it is derived from the domain
  primaryType: string;
  message: Record<string, unknown>;
}

const DOMAIN_FIELDS: TypedField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
  { name: "salt", type: "bytes32" },
];

const utf8 = (s: string) => new TextEncoder().encode(s);

function dependencies(primary: string, types: TypedDataTypes, found = new Set<string>()): Set<string> {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const field of types[primary]) dependencies(field.type, types, found);
  return found;
}

export function encodeType(primary: string, types: TypedDataTypes): string {
  const deps = [...dependencies(primary, types)].filter((t) => t !== primary).sort();
  return [primary, ...deps]
    .map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(",")})`)
    .join("");
}

export function typeHash(primary: string, types: TypedDataTypes): Uint8Array {
  return keccak256(utf8(encodeType(primary, types)));
}

function toUint(value: unknown, bits: number, field: string): bigint {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) n = BigInt(value);
  else throw new Error(`${field}: expected uint${bits}`);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${field}: out of range for uint${bits}`);
  return n;
}

function encodeValue(type: string, value: unknown, types: TypedDataTypes, field: string): Uint8Array {
  if (types[type]) {
    if (typeof value !== "object" || value === null) throw new Error(`${field}: expected ${type} struct`);
    return hashStruct(type, value as Record<string, unknown>, types);
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${field}: expected string`);
    return keccak256(utf8(value));
  }
  if (type === "address") {
    if (!isAddress(value)) throw new Error(`${field}: expected address`);
    return concatBytes(new Uint8Array(12), hexToBytes(value));
  }
  if (type === "bytes32") {
    if (!isBytes32(value)) throw new Error(`${field}: expected bytes32`);
    return hexToBytes(value);
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new Error(`${field}: expected bool`);
    return bigIntToBytes(value ? 1n : 0n);
  }
  const uint = /^uint(\d+)$/.exec(type);
  if (uint) return bigIntToBytes(toUint(value, Number(uint[1]), field));
  throw new Error(`${field}: unsupported EIP-712 type ${type}`);
}

export function hashStruct(primary: string, data: Record<string, unknown>, types: TypedDataTypes): Uint8Array {
  const fields = types[primary];
  if (!fields) throw new Error(`unknown type ${primary}`);
  const encoded = fields.map((f) => encodeValue(f.type, data[f.name], types, `${primary}.${f.name}`));
  return keccak256(concatBytes(typeHash(primary, types), ...encoded));
}

export function domainFields(domain: Record<string, unknown>): TypedField[] {
  return DOMAIN_FIELDS.filter((f) => domain[f.name] !== undefined);
}

export function hashDomain(domain: Record<string, unknown>): Uint8Array {
  return hashStruct("EIP712Domain", domain, { EIP712Domain: domainFields(domain) });
}

export function hashTypedData(data: TypedData): Uint8Array {
  return keccak256(
    concatBytes(
      Uint8Array.of(0x19, 0x01),
      hashDomain(data.domain),
      hashStruct(data.primaryType, data.message, data.types),
    ),
  );
}

export function hashTypedDataHex(data: TypedData): Hex {
  return bytesToHex(hashTypedData(data));
}

export function signTypedData(data: TypedData, privateKey: Hex): Hex {
  return signHash(hashTypedData(data), privateKey);
}

export function recoverTypedDataAddress(data: TypedData, signature: string): Hex {
  return recoverAddress(hashTypedData(data), signature);
}
