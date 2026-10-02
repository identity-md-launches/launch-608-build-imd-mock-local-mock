// Verification of a paid submit: the PAYMENT-SIGNATURE header (x402 v2,
// Permit2 "exact") and the QuoteApproval signature in the body. Pure: it
// takes the challenge the server issued and returns a verdict.

import { recoverTypedDataAddress } from "./crypto/eip712.js";
import { isAddress, sameAddress, type Hex } from "./crypto/hex.js";
import {
  DEADLINE_MARGIN_SECONDS,
  X402_PERMIT2_PROXY,
  canonicalJson,
  permit2TypedData,
  quoteApprovalFor,
  quoteApprovalTypedData,
  type PaymentChallenge,
  type PaymentPayload,
} from "./protocol.js";

export type VerifyErrorCode =
  | "invalid_payment_shape"
  | "invalid_body"
  | "payment_mismatch"
  | "deadline_too_late"
  | "permit_expired"
  | "invalid_payment_signature"
  | "nonce_reused"
  | "invalid_quote_signature";

export type VerifyResult =
  | { ok: true; payment: PaymentPayload; payer: Hex; nonce: string; paymentHash: Hex }
  | { ok: false; status: 400 | 402; error: VerifyErrorCode; message: string; field?: string };

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

type Shape = "string" | "number" | "decimal" | "address" | "signature" | { [key: string]: Shape };

// Exactly these keys, at every level. Anything extra or missing is a shape error.
const PAYMENT_SHAPE: Shape = {
  x402Version: "number",
  resource: { url: "string", description: "string", mimeType: "string" },
  accepted: {
    scheme: "string",
    network: "string",
    amount: "decimal",
    asset: "address",
    payTo: "address",
    maxTimeoutSeconds: "number",
    extra: { assetTransferMethod: "string", name: "string", version: "string" },
  },
  payload: {
    signature: "signature",
    permit2Authorization: {
      from: "address",
      permitted: { token: "address", amount: "decimal" },
      spender: "address",
      nonce: "decimal",
      deadline: "decimal",
      witness: { to: "address", validAfter: "decimal" },
    },
  },
};

function shapeProblems(value: unknown, shape: Shape, path: string, out: string[]): void {
  if (typeof shape === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      out.push(`${path || "payment"} must be an object`);
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (!(key in shape)) out.push(`${path ? `${path}.` : ""}${key} is not allowed`);
    }
    for (const [key, sub] of Object.entries(shape)) {
      const p = path ? `${path}.${key}` : key;
      if (!(key in obj)) out.push(`${p} is required`);
      else shapeProblems(obj[key], sub, p, out);
    }
    return;
  }
  const ok =
    shape === "string" ? typeof value === "string"
    : shape === "number" ? typeof value === "number" && Number.isSafeInteger(value)
    : shape === "decimal" ? typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= MAX_UINT256
    : shape === "address" ? isAddress(value)
    : typeof value === "string" && SIGNATURE.test(value);
  if (!ok) {
    const what = shape === "decimal" ? "a decimal string (uint256)" : shape === "signature" ? "a 65-byte 0x hex signature" : `a valid ${shape}`;
    out.push(`${path} must be ${what}`);
  }
}

function decodeHeader(header: string): unknown {
  const text = Buffer.from(header.trim(), "base64").toString("utf8");
  return JSON.parse(text);
}

const mismatch = (field: string, message: string): VerifyResult => ({
  ok: false,
  status: 402,
  error: "payment_mismatch",
  field,
  message,
});

export interface VerifyInput {
  challenge: PaymentChallenge;
  paymentHeader: string;
  body: unknown;
  nowSeconds: number;
  isNonceUsed(payer: string, nonce: string): boolean;
}

export function verifyPaidSubmit({ challenge, paymentHeader, body, nowSeconds, isNonceUsed }: VerifyInput): VerifyResult {
  let decoded: unknown;
  try {
    decoded = decodeHeader(paymentHeader);
  } catch {
    return { ok: false, status: 400, error: "invalid_payment_shape", message: "PAYMENT-SIGNATURE must be base64-encoded JSON" };
  }
  const problems: string[] = [];
  shapeProblems(decoded, PAYMENT_SHAPE, "", problems);
  if (problems.length > 0) {
    return { ok: false, status: 400, error: "invalid_payment_shape", message: problems.join("; ") };
  }
  const payment = decoded as PaymentPayload;
  const auth = payment.payload.permit2Authorization;
  const accepted = challenge.accepts[0];

  if (payment.x402Version !== 2) return mismatch("x402Version", "x402Version must be 2");
  if (canonicalJson(payment.resource) !== canonicalJson(challenge.resource)) {
    return mismatch("resource", "resource must equal the challenge's resource");
  }
  if (canonicalJson(payment.accepted) !== canonicalJson(accepted)) {
    return mismatch("accepted", "accepted must equal the challenge's accepts[0]");
  }
  if (!sameAddress(auth.permitted.token, challenge.quote.payment.asset)) {
    return mismatch("payload.permit2Authorization.permitted.token", "permitted.token must be the quote's asset");
  }
  if (auth.permitted.amount !== challenge.quote.payment.amount) {
    return mismatch("payload.permit2Authorization.permitted.amount", "permitted.amount must be the quote's amount");
  }
  if (!sameAddress(auth.spender, X402_PERMIT2_PROXY)) {
    return mismatch("payload.permit2Authorization.spender", `spender must be the x402 Permit2 proxy ${X402_PERMIT2_PROXY}`);
  }
  if (!sameAddress(auth.witness.to, challenge.quote.payment.payTo)) {
    return mismatch("payload.permit2Authorization.witness.to", "witness.to must be the quote's payTo");
  }
  if (auth.witness.validAfter !== "0") {
    return mismatch("payload.permit2Authorization.witness.validAfter", "witness.validAfter must be 0");
  }
  const deadline = BigInt(auth.deadline);
  if (deadline > BigInt(challenge.quote.expiresAt - DEADLINE_MARGIN_SECONDS)) {
    return {
      ok: false,
      status: 402,
      error: "deadline_too_late",
      field: "payload.permit2Authorization.deadline",
      message: `deadline must be at most quote.expiresAt - ${DEADLINE_MARGIN_SECONDS} (${challenge.quote.expiresAt - DEADLINE_MARGIN_SECONDS})`,
    };
  }
  if (deadline <= BigInt(nowSeconds)) {
    return { ok: false, status: 402, error: "permit_expired", field: "payload.permit2Authorization.deadline", message: "deadline has passed" };
  }

  let permitSigner: string;
  try {
    permitSigner = recoverTypedDataAddress(permit2TypedData(auth), payment.payload.signature);
  } catch (err) {
    return { ok: false, status: 402, error: "invalid_payment_signature", field: "payload.signature", message: (err as Error).message };
  }
  if (!sameAddress(permitSigner, auth.from)) {
    return {
      ok: false,
      status: 402,
      error: "invalid_payment_signature",
      field: "payload.signature",
      message: "Permit2 signature does not recover to permit2Authorization.from",
    };
  }
  if (isNonceUsed(auth.from, auth.nonce)) {
    return { ok: false, status: 402, error: "nonce_reused", field: "payload.permit2Authorization.nonce", message: "this Permit2 nonce was already used by this payer" };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid_body", message: "body must be {quoteSignature}" };
  }
  const extra = Object.keys(body).filter((k) => k !== "quoteSignature");
  const quoteSignature = (body as Record<string, unknown>).quoteSignature;
  if (extra.length > 0 || typeof quoteSignature !== "string" || !SIGNATURE.test(quoteSignature)) {
    return { ok: false, status: 400, error: "invalid_body", message: "body must be exactly {quoteSignature: 0x<65-byte signature>}" };
  }
  const approval = quoteApprovalFor(challenge, payment);
  let approvalSigner: string;
  try {
    approvalSigner = recoverTypedDataAddress(quoteApprovalTypedData(approval), quoteSignature);
  } catch (err) {
    return { ok: false, status: 402, error: "invalid_quote_signature", field: "quoteSignature", message: (err as Error).message };
  }
  if (!sameAddress(approvalSigner, auth.from)) {
    return {
      ok: false,
      status: 402,
      error: "invalid_quote_signature",
      field: "quoteSignature",
      message: "QuoteApproval signature does not recover to the payer; check every QuoteApproval field, including paymentHash",
    };
  }
  return { ok: true, payment, payer: auth.from as Hex, nonce: auth.nonce, paymentHash: approval.paymentHash as Hex };
}
