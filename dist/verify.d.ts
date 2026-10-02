import { type Hex } from "./crypto/hex.js";
import { type PaymentChallenge, type PaymentPayload } from "./protocol.js";
export type VerifyErrorCode = "invalid_payment_shape" | "invalid_body" | "payment_mismatch" | "deadline_too_late" | "permit_expired" | "invalid_payment_signature" | "nonce_reused" | "invalid_quote_signature";
export type VerifyResult = {
    ok: true;
    payment: PaymentPayload;
    payer: Hex;
    nonce: string;
    paymentHash: Hex;
} | {
    ok: false;
    status: 400 | 402;
    error: VerifyErrorCode;
    message: string;
    field?: string;
};
export interface VerifyInput {
    challenge: PaymentChallenge;
    paymentHeader: string;
    body: unknown;
    nowSeconds: number;
    isNonceUsed(payer: string, nonce: string): boolean;
}
export declare function verifyPaidSubmit({ challenge, paymentHeader, body, nowSeconds, isNonceUsed }: VerifyInput): VerifyResult;
