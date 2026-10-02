// A reference client for the paid-request flow. The conformance suite and
// the tests drive the mock through it, and it doubles as worked example code
// for anyone writing their own client.

import { randomBytes, randomUUID } from "node:crypto";
import { signTypedData } from "./crypto/eip712.js";
import { bytesToBigInt, sameAddress, type Hex } from "./crypto/hex.js";
import { privateKeyToAddress } from "./crypto/secp256k1.js";
import {
  DEADLINE_MARGIN_SECONDS,
  PENDING_STATUSES,
  X402_PERMIT2_PROXY,
  encodePaymentHeader,
  permit2TypedData,
  quoteApprovalFor,
  quoteApprovalTypedData,
  type PaymentChallenge,
  type PaymentPayload,
  type Permit2Authorization,
  type QuoteApproval,
  type RequestStatusResponse,
} from "./protocol.js";

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
export function signPayment(challenge: PaymentChallenge, privateKey: Hex, options: PaymentOptions = {}): SignedPayment {
  const accepted = challenge.accepts[0];
  const from = privateKeyToAddress(privateKey);
  const nonce = options.nonce ?? bytesToBigInt(randomBytes(32)).toString(10);
  const deadline = options.deadline ?? challenge.quote.expiresAt - DEADLINE_MARGIN_SECONDS;
  const permit2Authorization: Permit2Authorization = {
    from,
    permitted: { token: accepted.asset, amount: accepted.amount },
    spender: X402_PERMIT2_PROXY,
    nonce,
    deadline: String(deadline),
    witness: { to: accepted.payTo, validAfter: "0" },
  };
  return signAuthorization(challenge, permit2Authorization, privateKey);
}

/**
 * Wraps an already-built Permit2 authorization into the x402 payment object
 * and signs both it and the QuoteApproval. Lets tests sign deliberately wrong
 * authorizations with valid signatures.
 */
export function signAuthorization(challenge: PaymentChallenge, permit2Authorization: Permit2Authorization, privateKey: Hex): SignedPayment {
  const payment: PaymentPayload = {
    x402Version: 2,
    resource: challenge.resource,
    accepted: challenge.accepts[0],
    payload: {
      signature: signTypedData(permit2TypedData(permit2Authorization), privateKey),
      permit2Authorization,
    },
  };
  return signQuoteApproval(challenge, payment, privateKey);
}

/** Signs the QuoteApproval over an exact payment object, however it was built. */
export function signQuoteApproval(challenge: PaymentChallenge, payment: PaymentPayload, privateKey: Hex): SignedPayment {
  const approval = quoteApprovalFor(challenge, payment);
  return {
    payment,
    paymentHeader: encodePaymentHeader(payment),
    approval,
    quoteSignature: signTypedData(quoteApprovalTypedData(approval), privateKey),
  };
}

/** Step 4: problems with accepts[0] against capabilities and the quote (empty means fine). */
export function checkChallenge(challenge: PaymentChallenge, capabilities: Capabilities): string[] {
  const problems: string[] = [];
  const a = challenge.accepts?.[0];
  if (!a) return ["challenge has no accepts[0]"];
  const q = challenge.quote.payment;
  const terms = capabilities.actions?.find((entry) => entry.action === challenge.quote.action);
  if (!terms) return [`capabilities does not enable ${challenge.quote.action}`];
  if (a.scheme !== "exact") problems.push(`accepts[0].scheme is ${a.scheme}, expected exact`);
  if (a.network !== terms.payment.network || q.network !== terms.payment.network) {
    problems.push(`network differs from capabilities (${terms.payment.network})`);
  }
  if (a.extra?.assetTransferMethod !== "permit2") problems.push("accepts[0].extra.assetTransferMethod is not permit2");
  if (!sameAddress(a.asset, terms.payment.asset) || !sameAddress(a.asset, q.asset)) {
    problems.push("accepts[0].asset differs from capabilities or quote");
  }
  if (!sameAddress(a.payTo, terms.payment.payTo) || !sameAddress(a.payTo, q.payTo)) {
    problems.push("accepts[0].payTo differs from capabilities or quote");
  }
  // One unit per action, except the actions capabilities marks as priced per run.
  const units = BigInt(capabilities.pricedPer?.[challenge.quote.action] ? (challenge.quote.runs ?? 0) : 1);
  const expected = (BigInt(terms.payment.amount) * units).toString(10);
  if (a.amount !== expected || q.amount !== expected) {
    problems.push(`amount is ${a.amount}, expected ${expected} (${terms.payment.amount} x ${units})`);
  }
  if (challenge.quote.expiresAt - challenge.quote.issuedAt > terms.quoteTtlSeconds) {
    problems.push(`quote lives longer than quoteTtlSeconds (${terms.quoteTtlSeconds})`);
  }
  return problems;
}

export interface ActionCapability {
  action: string;
  version: string;
  payment: { network: string; asset: string; amount: string; payTo: string; decimals: number };
  quoteTtlSeconds: number;
  limits?: Record<string, number>;
  pricedPer?: string;
}

export interface Capabilities {
  actions: ActionCapability[];
  limits: Record<string, Record<string, number>>;
  launches: { defaultChainId: number; chains: Array<Record<string, unknown>> };
  pricedPer: Record<string, string>;
  [key: string]: unknown;
}

export interface HttpResult<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export class ImdClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON; keep the text
    }
    return { status: res.status, headers: res.headers, body: parsed as T };
  }

  capabilities() {
    return this.request<Capabilities>("GET", "/requests/capabilities");
  }

  openapi() {
    return this.request("GET", "/openapi.json");
  }

  /** The evaluator is noisy: retry while it reports blockers, up to `attempts` times. */
  async check(action: string, input: unknown, attempts = 3) {
    let last!: HttpResult;
    for (let i = 0; i < attempts; i++) {
      last = await this.request("POST", "/requests/check", { action, input });
      if (last.status !== 200 || last.body?.blockers?.length === 0) break;
    }
    return last;
  }

  quote(action: string, input: unknown, requestKey: string = randomUUID()) {
    return this.request("POST", "/requests/quote", { requestKey, action, input });
  }

  challenge(id: string) {
    return this.request<PaymentChallenge>("POST", `/requests/${encodeURIComponent(id)}/submit`);
  }

  submitPayment(id: string, paymentHeader: string, body: unknown) {
    return this.request("POST", `/requests/${encodeURIComponent(id)}/submit`, body, { "payment-signature": paymentHeader });
  }

  getRequest(id: string) {
    return this.request<RequestStatusResponse>("GET", `/requests/${encodeURIComponent(id)}`);
  }

  getJob(id: string) {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}`);
  }

  getJobResult(id: string) {
    return this.request("GET", `/jobs/${encodeURIComponent(id)}/result`);
  }

  /** Step 8: poll until the status leaves quoted, payment_pending and admission_pending. */
  async poll(id: string, { intervalMs = 0, maxPolls = 50 } = {}) {
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.getRequest(id);
      if (res.status !== 200) return res;
      if (!(PENDING_STATUSES as readonly string[]).includes(res.body.status)) return res;
      if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`request ${id} still pending after ${maxPolls} polls`);
  }

  /** The whole flow: quote, challenge, sign, submit. */
  async pay(action: string, input: unknown, privateKey: Hex, options: PaymentOptions = {}) {
    const quote = await this.quote(action, input);
    if (quote.status !== 201 && quote.status !== 200) throw new Error(`quote failed: ${quote.status} ${JSON.stringify(quote.body)}`);
    const id: string = quote.body.order.id;
    const challenge = await this.challenge(id);
    if (challenge.status !== 402) throw new Error(`expected 402 challenge, got ${challenge.status}`);
    const signed = signPayment(challenge.body, privateKey, options);
    const submit = await this.submitPayment(id, signed.paymentHeader, { quoteSignature: signed.quoteSignature });
    return { id, challenge: challenge.body, signed, submit };
  }
}
