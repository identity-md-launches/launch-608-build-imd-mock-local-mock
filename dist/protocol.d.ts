import type { TypedData, TypedDataTypes } from "./crypto/eip712.js";
import type { Hex } from "./crypto/hex.js";
export declare const EXPERIMENTAL_NOTICE = "Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.";
export declare const CHAIN_ID = 1;
export declare const NETWORK = "eip155:1";
/** IMD token on Ethereum mainnet. */
export declare const IMD_TOKEN: Hex;
export declare const IMD_DECIMALS = 18;
/** 0.5 IMD per action (per run for schedules). */
export declare const PRICE_PER_ACTION = "500000000000000000";
export declare const PERMIT2_ADDRESS: Hex;
/** x402 "exact" scheme Permit2 proxy: the spender of every permit. */
export declare const X402_PERMIT2_PROXY: Hex;
/** A permit deadline must be at least this many seconds before quote.expiresAt. */
export declare const DEADLINE_MARGIN_SECONDS = 5;
/** Statuses a client keeps polling through. */
export declare const PENDING_STATUSES: readonly ["quoted", "payment_pending", "admission_pending"];
export type OrderStatus = "quoted" | "payment_pending" | "admission_pending" | "running" | "completed" | "refused" | "expired";
export interface PaymentRequirements {
    scheme: "exact";
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: {
        assetTransferMethod: "permit2";
        name: string;
        version: string;
    };
}
export interface ResourceInfo {
    url: string;
    description: string;
    mimeType: string;
}
export interface Quote {
    id: string;
    quoteHash: string;
    action: string;
    payment: {
        asset: string;
        amount: string;
        payTo: string;
    };
    expiresAt: number;
}
export interface PaymentChallenge {
    x402Version: 2;
    error: "payment_required";
    accepts: PaymentRequirements[];
    quote: Quote;
    resource: ResourceInfo;
    resourceUrl: string;
    requesterScopeHash: string;
}
export interface Permit2Authorization {
    from: string;
    permitted: {
        token: string;
        amount: string;
    };
    spender: string;
    nonce: string;
    deadline: string;
    witness: {
        to: string;
        validAfter: string;
    };
}
export interface PaymentPayload {
    x402Version: 2;
    resource: ResourceInfo;
    accepted: PaymentRequirements;
    payload: {
        signature: string;
        permit2Authorization: Permit2Authorization;
    };
}
export interface QuoteApproval {
    resource: string;
    requesterScopeHash: string;
    quoteId: string;
    quoteHash: string;
    paymentHash: string;
    action: string;
    asset: string;
    amount: string;
    payTo: string;
    expiresAt: string;
}
export declare const PERMIT2_DOMAIN: {
    readonly name: "Permit2";
    readonly chainId: 1;
    readonly verifyingContract: `0x${string}`;
};
export declare const PERMIT2_TYPES: TypedDataTypes;
export declare const QUOTE_APPROVAL_DOMAIN: {
    readonly name: "IdentityMD Paid Action";
    readonly version: "1";
    readonly chainId: 1;
};
export declare const QUOTE_APPROVAL_TYPES: TypedDataTypes;
export declare function permit2TypedData(auth: Permit2Authorization): TypedData;
export declare function quoteApprovalTypedData(approval: QuoteApproval): TypedData;
/** The QuoteApproval a payer signs for a given challenge and payment. */
export declare function quoteApprovalFor(challenge: PaymentChallenge, payment: PaymentPayload): QuoteApproval;
/** JSON with object keys sorted recursively and no whitespace. */
export declare function canonicalJson(value: unknown): string;
export declare function sha256Hex(data: string | Uint8Array): string;
/** sha256 of the key-sorted JSON payment object, as a 0x-prefixed bytes32. */
export declare function paymentHash(payment: unknown): Hex;
export declare function encodePaymentHeader(payment: PaymentPayload): string;
