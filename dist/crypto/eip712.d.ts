import { type Hex } from "./hex.js";
export type TypedField = {
    name: string;
    type: string;
};
export type TypedDataTypes = Record<string, TypedField[]>;
export interface TypedData {
    domain: Record<string, unknown>;
    types: TypedDataTypes;
    primaryType: string;
    message: Record<string, unknown>;
}
export declare function encodeType(primary: string, types: TypedDataTypes): string;
export declare function typeHash(primary: string, types: TypedDataTypes): Uint8Array;
export declare function hashStruct(primary: string, data: Record<string, unknown>, types: TypedDataTypes): Uint8Array;
export declare function domainFields(domain: Record<string, unknown>): TypedField[];
export declare function hashDomain(domain: Record<string, unknown>): Uint8Array;
export declare function hashTypedData(data: TypedData): Uint8Array;
export declare function hashTypedDataHex(data: TypedData): Hex;
export declare function signTypedData(data: TypedData, privateKey: Hex): Hex;
export declare function recoverTypedDataAddress(data: TypedData, signature: string): Hex;
