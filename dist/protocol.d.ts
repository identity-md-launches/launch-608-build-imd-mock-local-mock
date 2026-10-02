import type { TypedData, TypedDataTypes } from "./crypto/eip712.js";
import type { Hex } from "./crypto/hex.js";
export declare const EXPERIMENTAL_NOTICE = "Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.";
export declare const CHAIN_ID = 1;
export declare const NETWORK = "eip155:1";
/** IMD token on Ethereum mainnet. */
export declare const IMD_TOKEN: Hex;
export declare const IMD_DECIMALS = 18;
/** 0.5 IMD per action, and per run for a schedule. */
export declare const PRICE_PER_ACTION = "500000000000000000";
export declare const DEFAULT_QUOTE_TTL_SECONDS = 600;
/** accepts[0].maxTimeoutSeconds, as the live API reports it. */
export declare const MAX_TIMEOUT_SECONDS = 300;
export declare const PERMIT2_ADDRESS: Hex;
/** x402 "exact" scheme Permit2 proxy: the spender of every permit. */
export declare const X402_PERMIT2_PROXY: Hex;
/** A permit deadline must be at least this many seconds before quote.expiresAt. */
export declare const DEADLINE_MARGIN_SECONDS = 5;
/** `GET /requests/:id` statuses a client keeps polling through. */
export declare const PENDING_STATUSES: readonly ["quoted", "payment_pending", "admission_pending"];
/** The status of the order itself. */
export type OrderStatus = "quoted" | "expired" | "payment_pending" | "payment_failed" | "paid";
/** The top-level status of `GET /requests/:id`. */
export type RequestStatus = OrderStatus | "admission_pending" | "admitted";
export interface PaymentRequirements {
    scheme: "exact";
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: {
        assetTransferMethod: "permit2";
    };
}
export interface ResourceInfo {
    url: string;
    description: string;
    mimeType: string;
}
export interface QuotePayment {
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    decimals: number;
    scheme: "exact";
}
export interface Quote {
    v: 1;
    id: string;
    action: string;
    policyVersion: string;
    inputHash: string;
    issuedAt: number;
    expiresAt: number;
    payment: QuotePayment;
    /** Price of one unit; set on the actions charged per run. */
    unitAmount?: string;
    /** Units bought; set on the actions charged per run. */
    runs?: number;
    terms: {
        purchase: "action-admission";
        resultGuaranteed: false;
    };
    quoteHash: string;
}
export interface Order {
    id: string;
    requestKey: string;
    status: OrderStatus;
    paidAt: string | null;
    quote: Quote;
    /** The prepared input the quote pinned, as canonical JSON. */
    inputJson: string;
    createdAt: string;
}
export interface PaymentChallenge {
    x402Version: 2;
    resource: ResourceInfo;
    accepts: PaymentRequirements[];
    quote: Quote;
    requesterScopeHash: string;
    resourceUrl: string;
    /** The prepared input saved with the quote. Inspect it before signing. */
    input: unknown;
}
/** `GET /requests/:id`. */
export interface RequestStatusResponse {
    status: RequestStatus;
    order: Order;
    payment: ({
        status: string;
        paid: boolean;
        transactionHash: string;
    } & Record<string, unknown>) | null;
    admission: {
        action: string;
        result: AdmissionResult;
    } | null;
}
export type AdmissionResult = {
    kind: string;
} & Record<string, unknown>;
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
    /** Optional and, if present, empty: what a stock x402 client may attach. */
    extensions?: Record<string, never>;
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
/** A deterministic, well-formed UUID v4 derived from a label. */
export declare function uuidFrom(label: string): string;
