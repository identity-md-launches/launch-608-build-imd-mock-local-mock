// Shapes and constants of the IMD paid-request flow, shared by the mock
// server, the reference client and the conformance suite.

import { createHash } from "node:crypto";
import type { TypedData, TypedDataTypes } from "./crypto/eip712.js";
import type { Hex } from "./crypto/hex.js";

export const EXPERIMENTAL_NOTICE =
  "Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.";

export const CHAIN_ID = 1;
export const NETWORK = "eip155:1";
/** IMD token on Ethereum mainnet. */
export const IMD_TOKEN: Hex = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
export const IMD_DECIMALS = 18;
/** 0.5 IMD per action (per run for schedules). */
export const PRICE_PER_ACTION = "500000000000000000";
export const PERMIT2_ADDRESS: Hex = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** x402 "exact" scheme Permit2 proxy: the spender of every permit. */
export const X402_PERMIT2_PROXY: Hex = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
/** A permit deadline must be at least this many seconds before quote.expiresAt. */
export const DEADLINE_MARGIN_SECONDS = 5;

/** Statuses a client keeps polling through. */
export const PENDING_STATUSES = ["quoted", "payment_pending", "admission_pending"] as const;

export type OrderStatus =
  | "quoted"
  | "payment_pending"
  | "admission_pending"
  | "running"
  | "completed"
  | "refused"
  | "expired";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { assetTransferMethod: "permit2"; name: string; version: string };
}

export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

export interface Quote {
  id: string;
  quoteHash: string; // 64 hex chars, no 0x
  action: string;
  payment: { asset: string; amount: string; payTo: string };
  expiresAt: number; // unix seconds
}

export interface PaymentChallenge {
  x402Version: 2;
  error: "payment_required";
  accepts: PaymentRequirements[];
  quote: Quote;
  resource: ResourceInfo;
  resourceUrl: string;
  requesterScopeHash: string; // 64 hex chars, no 0x
}

export interface Permit2Authorization {
  from: string;
  permitted: { token: string; amount: string };
  spender: string;
  nonce: string;
  deadline: string;
  witness: { to: string; validAfter: string };
}

export interface PaymentPayload {
  x402Version: 2;
  resource: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: string; permit2Authorization: Permit2Authorization };
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

export const PERMIT2_DOMAIN = {
  name: "Permit2",
  chainId: CHAIN_ID,
  verifyingContract: PERMIT2_ADDRESS,
} as const;

export const PERMIT2_TYPES: TypedDataTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Witness: [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ],
};

export const QUOTE_APPROVAL_DOMAIN = {
  name: "IdentityMD Paid Action",
  version: "1",
  chainId: CHAIN_ID,
} as const;

export const QUOTE_APPROVAL_TYPES: TypedDataTypes = {
  QuoteApproval: [
    { name: "resource", type: "string" },
    { name: "requesterScopeHash", type: "bytes32" },
    { name: "quoteId", type: "string" },
    { name: "quoteHash", type: "bytes32" },
    { name: "paymentHash", type: "bytes32" },
    { name: "action", type: "string" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "payTo", type: "address" },
    { name: "expiresAt", type: "uint256" },
  ],
};

export function permit2TypedData(auth: Permit2Authorization): TypedData {
  return {
    domain: { ...PERMIT2_DOMAIN },
    types: PERMIT2_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: auth.permitted.token, amount: auth.permitted.amount },
      spender: auth.spender,
      nonce: auth.nonce,
      deadline: auth.deadline,
      witness: { to: auth.witness.to, validAfter: auth.witness.validAfter },
    },
  };
}

export function quoteApprovalTypedData(approval: QuoteApproval): TypedData {
  return {
    domain: { ...QUOTE_APPROVAL_DOMAIN },
    types: QUOTE_APPROVAL_TYPES,
    primaryType: "QuoteApproval",
    message: { ...approval },
  };
}

/** The QuoteApproval a payer signs for a given challenge and payment. */
export function quoteApprovalFor(challenge: PaymentChallenge, payment: PaymentPayload): QuoteApproval {
  return {
    resource: challenge.resourceUrl,
    requesterScopeHash: `0x${challenge.requesterScopeHash}`,
    quoteId: challenge.quote.id,
    quoteHash: `0x${challenge.quote.quoteHash}`,
    paymentHash: paymentHash(payment),
    action: challenge.quote.action,
    asset: challenge.quote.payment.asset,
    amount: challenge.quote.payment.amount,
    payTo: challenge.quote.payment.payTo,
    expiresAt: String(challenge.quote.expiresAt),
  };
}

/** JSON with object keys sorted recursively and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 of the key-sorted JSON payment object, as a 0x-prefixed bytes32. */
export function paymentHash(payment: unknown): Hex {
  return `0x${sha256Hex(canonicalJson(payment))}`;
}

export function encodePaymentHeader(payment: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
}
