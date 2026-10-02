import { type Hex } from "./crypto/hex.js";
import { type PaymentChallenge, type PaymentPayload, type Permit2Authorization, type QuoteApproval } from "./protocol.js";
export interface SignedPayment {
    payment: PaymentPayload;
    paymentHeader: string;
    approval: QuoteApproval;
    quoteSignature: Hex;
}
export interface PaymentOptions {
    /** Permit2 nonce as a decimal string. Default: 32 random bytes. */
    nonce?: string;
    /** Permit deadline (unix seconds). Default: quote.expiresAt - 5. */
    deadline?: number;
}
/** Steps 5 and 6: build and sign the Permit2 payment and the QuoteApproval. */
export declare function signPayment(challenge: PaymentChallenge, privateKey: Hex, options?: PaymentOptions): SignedPayment;
/**
 * Wraps an already-built Permit2 authorization into the x402 payment object
 * and signs both it and the QuoteApproval. Lets tests sign deliberately wrong
 * authorizations with valid signatures.
 */
export declare function signAuthorization(challenge: PaymentChallenge, permit2Authorization: Permit2Authorization, privateKey: Hex): SignedPayment;
/** Step 4: problems with accepts[0] against capabilities and the quote (empty means fine). */
export declare function checkChallenge(challenge: PaymentChallenge, capabilities: Capabilities): string[];
export interface Capabilities {
    price: string;
    asset: string;
    payTo: string;
    network: string;
    quoteLifetimeSeconds: number;
    [key: string]: unknown;
}
export interface HttpResult<T = any> {
    status: number;
    headers: Headers;
    body: T;
}
export declare class ImdClient {
    readonly baseUrl: string;
    readonly token: string;
    constructor(baseUrl: string, token: string);
    request<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult<T>>;
    capabilities(): Promise<HttpResult<Capabilities>>;
    openapi(): Promise<HttpResult<any>>;
    /** The evaluator is noisy: retry a refusal up to `attempts` times in total. */
    check(action: string, input: unknown, attempts?: number): Promise<HttpResult<any>>;
    quote(action: string, input: unknown, requestKey?: string): Promise<HttpResult<any>>;
    challenge(id: string): Promise<HttpResult<PaymentChallenge>>;
    submitPayment(id: string, paymentHeader: string, body: unknown): Promise<HttpResult<any>>;
    getRequest(id: string): Promise<HttpResult<any>>;
    getJob(id: string): Promise<HttpResult<any>>;
    /** Step 8: poll until the status leaves quoted, payment_pending and admission_pending. */
    poll(id: string, { intervalMs, maxPolls }?: {
        intervalMs?: number | undefined;
        maxPolls?: number | undefined;
    }): Promise<HttpResult<any>>;
    /** The whole flow: quote, challenge, sign, submit. */
    pay(action: string, input: unknown, privateKey: Hex, options?: PaymentOptions): Promise<{
        id: string;
        challenge: PaymentChallenge;
        signed: SignedPayment;
        submit: HttpResult<any>;
    }>;
}
