// A correctly signed payment is accepted; changing any single field of it,
// or of what the signatures cover, is refused. One test per field.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { signAuthorization, signPayment, signQuoteApproval, type SignedPayment } from "../src/client.js";
import { signTypedData } from "../src/crypto/eip712.js";
import { FIXED_JOB_INPUT, FIXED_NONCE, FIXED_NOW_MS, TEST_BEARER_TOKEN, TEST_PAYER_KEY, testPayerKey } from "../src/fixtures.js";
import { privateKeyToAddress } from "../src/crypto/secp256k1.js";
import { encodePaymentHeader, quoteApprovalTypedData, sha256Hex, type PaymentChallenge, type QuoteApproval } from "../src/protocol.js";
import { HttpError, MockState } from "../src/server.js";

const OTHER = "0x1111111111111111111111111111111111111111";
const SCOPE = sha256Hex(TEST_BEARER_TOKEN);

function setup(requestKey = "00000000-0000-4000-8000-000000000042") {
  const state = new MockState({ now: () => FIXED_NOW_MS });
  const { order } = state.quote(SCOPE, { requestKey, action: "job.open", input: FIXED_JOB_INPUT }, "http://127.0.0.1:8402");
  const challenge = state.submit(SCOPE, order.id, undefined, undefined).body as PaymentChallenge;
  const signed = signPayment(challenge, TEST_PAYER_KEY, { nonce: FIXED_NONCE });
  return { state, id: order.id, challenge, signed };
}

function submit(state: MockState, id: string, header: string, body: unknown) {
  try {
    const res = state.submit(SCOPE, id, header, body);
    return { status: res.status, error: (res.body as any).error as string | undefined };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, error: err.code };
    throw err;
  }
}

function assertRefused(state: MockState, id: string, header: string, body: unknown, expectedError?: string) {
  const res = submit(state, id, header, body);
  assert.ok(res.status === 400 || res.status === 402, `expected a refusal, got ${res.status} ${res.error}`);
  if (expectedError) assert.equal(res.error, expectedError);
  assert.equal(state.orders.get(id)!.status, "payment_pending", "a refused payment must not change the order");
  assert.equal(state.usedNonces.size, 0, "a refused payment must not burn the nonce");
}

/** Deep-clones the payment and applies one change at a dotted path. */
function changed(signed: SignedPayment, path: string, fn: (old: any) => any) {
  const copy = JSON.parse(JSON.stringify(signed.payment));
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce((o, k) => o[k], copy);
  const last = keys[keys.length - 1];
  parent[last] = fn(parent[last]);
  return encodePaymentHeader(copy);
}

/** Changes one hex character in the middle of a signature (inside s). */
function flipSignature(sig: string): string {
  const i = 100;
  return sig.slice(0, i) + (sig[i] === "0" ? "1" : "0") + sig.slice(i + 1);
}

test("a correctly signed payment is accepted", () => {
  const { state, id, signed } = setup();
  const res = state.submit(SCOPE, id, signed.paymentHeader, { quoteSignature: signed.quoteSignature });
  assert.equal(res.status, 202);
  assert.equal((res.body as any).status, "admission_pending");
  assert.equal(state.orders.get(id)!.status, "paid");
  assert.equal(state.orders.get(id)!.payment!.payer, privateKeyToAddress(TEST_PAYER_KEY));
  assert.ok(res.headers["payment-response"]);
});

test("the correct payment is still accepted after a run of refusals", () => {
  const { state, id, signed } = setup();
  assertRefused(state, id, changed(signed, "payload.permit2Authorization.nonce", (n) => String(BigInt(n) + 1n)), { quoteSignature: signed.quoteSignature });
  assertRefused(state, id, signed.paymentHeader, { quoteSignature: flipSignature(signed.quoteSignature) });
  assert.equal(state.submit(SCOPE, id, signed.paymentHeader, { quoteSignature: signed.quoteSignature }).status, 202);
});

test("resending the exact submit bytes returns the first outcome and settles nothing twice", () => {
  const { state, id, signed } = setup();
  const body = { quoteSignature: signed.quoteSignature };
  const first = state.submit(SCOPE, id, signed.paymentHeader, body);
  const second = state.submit(SCOPE, id, signed.paymentHeader, body);
  assert.equal(second.status, first.status);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.headers["payment-replayed"], "true");
  assert.equal(state.usedNonces.size, 1, "the nonce is spent once");
});

test("a second, differently signed payment for a paid order is 409 already_paid", () => {
  const { state, id, challenge, signed } = setup();
  state.submit(SCOPE, id, signed.paymentHeader, { quoteSignature: signed.quoteSignature });
  const other = signPayment(challenge, TEST_PAYER_KEY, { nonce: String(BigInt(FIXED_NONCE) + 1n) });
  assert.deepEqual(submit(state, id, other.paymentHeader, { quoteSignature: other.quoteSignature }), {
    status: 409,
    error: "already_paid",
  });
});

describe("payment object: any single field changed after signing is refused", () => {
  const cases: Array<[string, (old: any) => any]> = [
    ["x402Version", () => 1],
    ["resource.url", (u) => `${u}?x=1`],
    ["resource.description", () => "something else"],
    ["resource.mimeType", () => "text/plain"],
    ["accepted.scheme", () => "upto"],
    ["accepted.network", () => "eip155:8453"],
    ["accepted.amount", () => "1"],
    ["accepted.asset", () => OTHER],
    ["accepted.payTo", () => OTHER],
    ["accepted.maxTimeoutSeconds", (n) => n + 1],
    ["accepted.extra.assetTransferMethod", () => "eip3009"],
    ["payload.signature", flipSignature],
    ["payload.permit2Authorization.from", () => OTHER],
    ["payload.permit2Authorization.permitted.token", () => OTHER],
    ["payload.permit2Authorization.permitted.amount", () => "1"],
    ["payload.permit2Authorization.spender", () => OTHER],
    ["payload.permit2Authorization.nonce", (n) => String(BigInt(n) + 1n)],
    ["payload.permit2Authorization.deadline", (d) => String(BigInt(d) - 1n)],
    ["payload.permit2Authorization.witness.to", () => OTHER],
    ["payload.permit2Authorization.witness.validAfter", () => "1"],
  ];
  for (const [path, fn] of cases) {
    test(path, () => {
      const { state, id, signed } = setup();
      assertRefused(state, id, changed(signed, path, fn), { quoteSignature: signed.quoteSignature });
    });
  }

  test("body.quoteSignature", () => {
    const { state, id, signed } = setup();
    assertRefused(state, id, signed.paymentHeader, { quoteSignature: flipSignature(signed.quoteSignature) }, "invalid_quote_signature");
  });
});

describe("payment object: shape violations are invalid_payment_shape", () => {
  const cases: Array<[string, (p: any) => void]> = [
    ["extra top-level field", (p) => (p.extra = 1)],
    ["extra field in permit2Authorization", (p) => (p.payload.permit2Authorization.chainId = "1")],
    ["extra field in witness", (p) => (p.payload.permit2Authorization.witness.extra = "0x")],
    ["extra field in accepted", (p) => (p.accepted.foo = "bar")],
    ["extra field in accepted.extra", (p) => (p.accepted.extra.name = "IMD")],
    ["number instead of decimal string", (p) => (p.payload.permit2Authorization.nonce = 5)],
    ["hex instead of decimal string", (p) => (p.payload.permit2Authorization.deadline = "0x10")],
    ["missing field", (p) => delete p.payload.permit2Authorization.spender],
    ["non-empty extensions", (p) => (p.extensions = { tip: "1" })],
  ];
  for (const [name, mutate] of cases) {
    test(name, () => {
      const { state, id, signed } = setup();
      const copy = JSON.parse(JSON.stringify(signed.payment));
      mutate(copy);
      assertRefused(state, id, encodePaymentHeader(copy), { quoteSignature: signed.quoteSignature }, "invalid_payment_shape");
    });
  }

  // A shape check written with `in` would accept these: they are keys of
  // Object.prototype, not declared payment fields.
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    test(`inherited property name: ${key}`, () => {
      const { state, id, challenge, signed } = setup();
      const payment = JSON.parse(`${JSON.stringify(signed.payment).slice(0, -1)},${JSON.stringify(key)}:"extra"}`);
      // Re-sign the approval so only the shape, not the paymentHash, can refuse it.
      const resigned = signQuoteApproval(challenge, payment, TEST_PAYER_KEY);
      assertRefused(state, id, resigned.paymentHeader, { quoteSignature: resigned.quoteSignature }, "invalid_payment_shape");
    });
  }

  test("an empty extensions object is accepted, as a stock x402 client sends it", () => {
    const { state, id, challenge, signed } = setup();
    const resigned = signQuoteApproval(challenge, { ...signed.payment, extensions: {} }, TEST_PAYER_KEY);
    assert.equal(state.submit(SCOPE, id, resigned.paymentHeader, { quoteSignature: resigned.quoteSignature }).status, 202);
  });

  test("header that is not base64 JSON", () => {
    const { state, id, signed } = setup();
    assertRefused(state, id, "not base64 json", { quoteSignature: signed.quoteSignature }, "invalid_payment_shape");
  });

  test("submit body with an extra field", () => {
    const { state, id, signed } = setup();
    assertRefused(state, id, signed.paymentHeader, { quoteSignature: signed.quoteSignature, note: "hi" }, "invalid_body");
  });
});

describe("Permit2: a validly signed authorization with any wrong field is refused", () => {
  const cases: Array<[string, (a: any, c: PaymentChallenge) => void, string]> = [
    ["permitted.token", (a) => (a.permitted.token = OTHER), "payment_mismatch"],
    ["permitted.amount", (a) => (a.permitted.amount = "1"), "payment_mismatch"],
    ["spender", (a) => (a.spender = OTHER), "payment_mismatch"],
    ["witness.to", (a) => (a.witness.to = OTHER), "payment_mismatch"],
    ["witness.validAfter", (a) => (a.witness.validAfter = "1"), "payment_mismatch"],
    ["deadline after expiresAt - 5", (a, c) => (a.deadline = String(c.quote.expiresAt - 4)), "deadline_too_late"],
    ["deadline already passed", (a) => (a.deadline = String(FIXED_NOW_MS / 1000)), "permit_expired"],
  ];
  for (const [name, mutate, error] of cases) {
    test(name, () => {
      const { state, id, challenge, signed } = setup();
      const auth = JSON.parse(JSON.stringify(signed.payment.payload.permit2Authorization));
      mutate(auth, challenge);
      const resigned = signAuthorization(challenge, auth, TEST_PAYER_KEY);
      assertRefused(state, id, resigned.paymentHeader, { quoteSignature: resigned.quoteSignature }, error);
    });
  }

  test("signed by a key other than `from`", () => {
    const { state, id, challenge, signed } = setup();
    const forged = signAuthorization(challenge, signed.payment.payload.permit2Authorization, testPayerKey(7));
    assertRefused(state, id, forged.paymentHeader, { quoteSignature: signed.quoteSignature }, "invalid_payment_signature");
  });
});

describe("QuoteApproval: a validly signed approval with any wrong field is refused", () => {
  const cases: Array<[keyof QuoteApproval, string]> = [
    ["resource", "http://127.0.0.1:8402/requests/other"],
    ["requesterScopeHash", `0x${"ab".repeat(32)}`],
    ["quoteId", "00000000-0000-4000-8000-00000000ffff"],
    ["quoteHash", `0x${"cd".repeat(32)}`],
    ["paymentHash", `0x${"ef".repeat(32)}`],
    ["action", "launch.open"],
    ["asset", OTHER],
    ["amount", "1"],
    ["payTo", OTHER],
    ["expiresAt", "1"],
  ];
  for (const [field, value] of cases) {
    test(field, () => {
      const { state, id, signed } = setup();
      const approval = { ...signed.approval, [field]: value };
      const quoteSignature = signTypedData(quoteApprovalTypedData(approval), TEST_PAYER_KEY);
      assertRefused(state, id, signed.paymentHeader, { quoteSignature }, "invalid_quote_signature");
    });
  }

  test("signed by a key other than the payer", () => {
    const { state, id, signed } = setup();
    const quoteSignature = signTypedData(quoteApprovalTypedData(signed.approval), testPayerKey(7));
    assertRefused(state, id, signed.paymentHeader, { quoteSignature }, "invalid_quote_signature");
  });

  test("paymentHash is sha256 of the key-sorted payment, so key order in the header does not matter", () => {
    const { state, id, signed } = setup();
    const reverseKeys = (v: any): any =>
      v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])])) : v;
    const reordered = reverseKeys(signed.payment);
    const header = Buffer.from(JSON.stringify(reordered)).toString("base64");
    assert.notEqual(header, signed.paymentHeader);
    assert.equal(state.submit(SCOPE, id, header, { quoteSignature: signed.quoteSignature }).status, 202);
  });
});

test("an expired quote is refused with 410 even with a valid payment", () => {
  let now = FIXED_NOW_MS;
  const state = new MockState({ now: () => now });
  const { order } = state.quote(SCOPE, { requestKey: "00000000-0000-4000-8000-000000000043", action: "job.open", input: FIXED_JOB_INPUT }, "http://x");
  const challenge = state.submit(SCOPE, order.id, undefined, undefined).body as PaymentChallenge;
  const signed = signPayment(challenge, TEST_PAYER_KEY);
  now += (challenge.quote.expiresAt - FIXED_NOW_MS / 1000) * 1000;
  const res = submit(state, order.id, signed.paymentHeader, { quoteSignature: signed.quoteSignature });
  assert.deepEqual(res, { status: 410, error: "quote_expired" });
  assert.equal(state.orders.get(order.id)!.status, "expired");
});
