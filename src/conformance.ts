// The conformance suite: drives a server through every step of the
// paid-request flow and checks status codes and response shapes. Run it
// against the mock (default) or any server that speaks the same API.

import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { ImdClient, checkChallenge, signAuthorization, signPayment, type Capabilities } from "./client.js";
import { signTypedData } from "./crypto/eip712.js";
import { isAddress, type Hex } from "./crypto/hex.js";
import { TEST_PAYER_KEY, testPayerKey } from "./fixtures.js";
import {
  IMD_TOKEN,
  NETWORK,
  PRICE_PER_ACTION,
  encodePaymentHeader,
  quoteApprovalTypedData,
  type PaymentChallenge,
} from "./protocol.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
}

interface Context {
  client: ImdClient;
  baseUrl: string;
  privateKey: Hex;
  capabilities?: Capabilities;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ECHO = { action: "echo", input: { message: "hello from the conformance suite" } };
const IMPLEMENT_INPUT = {
  repoUrl: "https://github.com/example/widget",
  baseCommit: "0123456789abcdef0123456789abcdef01234567",
  objective: "Add a conformance-suite test objective of reasonable length.",
};

async function newChallenge(ctx: Context, action = ECHO.action, input: unknown = ECHO.input) {
  const quote = await ctx.client.quote(action, input);
  assert.equal(quote.status, 201, `quote: ${JSON.stringify(quote.body)}`);
  const challenge = await ctx.client.challenge(quote.body.order.id);
  assert.equal(challenge.status, 402);
  return { id: quote.body.order.id as string, challenge: challenge.body as PaymentChallenge };
}

function expectRefusal(res: { status: number; body: any }, status: number, error: string) {
  assert.equal(res.status, status, `expected ${status} ${error}, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, error);
}

export const CHECKS: Array<{ name: string; run(ctx: Context): Promise<void> }> = [
  {
    name: "GET /requests/capabilities reports price, asset, payTo, quote lifetime and launch chains",
    async run(ctx) {
      const res = await ctx.client.capabilities();
      assert.equal(res.status, 200);
      const c = res.body;
      assert.equal(c.price, PRICE_PER_ACTION);
      assert.equal(c.asset.toLowerCase(), IMD_TOKEN);
      assert.equal(c.network, NETWORK);
      assert.ok(isAddress(c.payTo), "payTo is an address");
      assert.ok(Number.isInteger(c.quoteLifetimeSeconds) && c.quoteLifetimeSeconds > 0);
      assert.ok(Array.isArray(c.launchChains) && c.launchChains.length > 0);
      ctx.capabilities = c;
    },
  },
  {
    name: "GET /openapi.json lists actions and limits under x-imd-actions",
    async run(ctx) {
      const res = await ctx.client.openapi();
      assert.equal(res.status, 200);
      const actions = res.body["x-imd-actions"];
      assert.ok(actions && typeof actions === "object" && Object.keys(actions).length > 0);
      for (const [name, spec] of Object.entries<any>(actions)) {
        assert.ok(spec.inputSchema, `${name} has inputSchema`);
        assert.ok(spec.limits, `${name} has limits`);
      }
    },
  },
  {
    name: "browser origins get 403",
    async run(ctx) {
      const res = await ctx.client.request("GET", "/requests/capabilities", undefined, { origin: "https://example.com" });
      expectRefusal(res, 403, "browser_origin_forbidden");
    },
  },
  {
    name: "POST /requests/quote without a bearer token gets 401",
    async run(ctx) {
      const anonymous = new ImdClient(ctx.baseUrl, "not-a-token");
      const res = await anonymous.quote(ECHO.action, ECHO.input);
      assert.equal(res.status, 401);
    },
  },
  {
    name: "POST /requests/check accepts a valid body within 3 attempts",
    async run(ctx) {
      const res = await ctx.client.check(ECHO.action, ECHO.input, 3);
      assert.equal(res.status, 200);
      assert.equal(res.body.verdict, "accept");
      assert.ok(Array.isArray(res.body.reasons));
    },
  },
  {
    name: "POST /requests/check refuses the canned [refuse] input on every attempt",
    async run(ctx) {
      const res = await ctx.client.check("echo", { message: "please [refuse] this" }, 3);
      assert.equal(res.status, 200);
      assert.equal(res.body.verdict, "refuse");
    },
  },
  {
    name: "POST /requests/quote with invalid input gets 422 invalid_input listing problems",
    async run(ctx) {
      const res = await ctx.client.quote("echo", { message: "" });
      expectRefusal(res, 422, "invalid_input");
      assert.ok(Array.isArray(res.body.problems) && res.body.problems.length > 0);
    },
  },
  {
    name: "POST /requests/quote returns {order:{id}} and is idempotent on requestKey",
    async run(ctx) {
      const key = randomUUID();
      const first = await ctx.client.quote(ECHO.action, ECHO.input, key);
      assert.equal(first.status, 201);
      assert.equal(typeof first.body.order.id, "string");
      const again = await ctx.client.quote(ECHO.action, ECHO.input, key);
      assert.equal(again.status, 200);
      assert.equal(again.body.order.id, first.body.order.id);
    },
  },
  {
    name: "POST /requests/{id}/submit without payment returns a 402 challenge that matches capabilities",
    async run(ctx) {
      const { challenge } = await newChallenge(ctx);
      assert.equal(challenge.x402Version, 2);
      assert.ok(Array.isArray(challenge.accepts) && challenge.accepts.length > 0);
      assert.equal(typeof challenge.quote.id, "string");
      assert.match(challenge.quote.quoteHash, HEX64);
      assert.equal(challenge.quote.action, ECHO.action);
      assert.ok(Number.isInteger(challenge.quote.expiresAt));
      assert.equal(typeof challenge.resourceUrl, "string");
      assert.equal(challenge.resource.url, challenge.resourceUrl);
      assert.match(challenge.requesterScopeHash, HEX64);
      const caps = ctx.capabilities ?? (await ctx.client.capabilities()).body;
      assert.deepEqual(checkChallenge(challenge, caps), []);
    },
  },
  {
    name: "a payment object with an extra field is refused as invalid_payment_shape",
    async run(ctx) {
      const { id, challenge } = await newChallenge(ctx);
      const signed = signPayment(challenge, ctx.privateKey);
      const header = encodePaymentHeader({ ...signed.payment, extra: "nope" } as any);
      expectRefusal(await ctx.client.submitPayment(id, header, { quoteSignature: signed.quoteSignature }), 400, "invalid_payment_shape");
    },
  },
  {
    name: "a correctly signed permit for the wrong amount is refused",
    async run(ctx) {
      const { id, challenge } = await newChallenge(ctx);
      const auth = signPayment(challenge, ctx.privateKey).payment.payload.permit2Authorization;
      const signed = signAuthorization(challenge, { ...auth, permitted: { ...auth.permitted, amount: "1" } }, ctx.privateKey);
      expectRefusal(await ctx.client.submitPayment(id, signed.paymentHeader, { quoteSignature: signed.quoteSignature }), 402, "payment_mismatch");
    },
  },
  {
    name: "a permit deadline later than quote.expiresAt - 5 is refused",
    async run(ctx) {
      const { id, challenge } = await newChallenge(ctx);
      const signed = signPayment(challenge, ctx.privateKey, { deadline: challenge.quote.expiresAt - 4 });
      expectRefusal(await ctx.client.submitPayment(id, signed.paymentHeader, { quoteSignature: signed.quoteSignature }), 402, "deadline_too_late");
    },
  },
  {
    name: "a Permit2 signature from someone other than `from` is refused",
    async run(ctx) {
      const { id, challenge } = await newChallenge(ctx);
      const signed = signPayment(challenge, ctx.privateKey);
      const forged = signPayment(challenge, testPayerKey(99), { nonce: signed.payment.payload.permit2Authorization.nonce });
      const payment = { ...signed.payment, payload: { ...signed.payment.payload, signature: forged.payment.payload.signature } };
      const res = await ctx.client.submitPayment(id, encodePaymentHeader(payment), { quoteSignature: signed.quoteSignature });
      expectRefusal(res, 402, "invalid_payment_signature");
    },
  },
  {
    name: "a QuoteApproval with the wrong paymentHash is refused",
    async run(ctx) {
      const { id, challenge } = await newChallenge(ctx);
      const signed = signPayment(challenge, ctx.privateKey);
      const wrong = { ...signed.approval, paymentHash: `0x${"00".repeat(32)}` };
      const quoteSignature = signTypedData(quoteApprovalTypedData(wrong), ctx.privateKey);
      expectRefusal(await ctx.client.submitPayment(id, signed.paymentHeader, { quoteSignature }), 402, "invalid_quote_signature");
    },
  },
  {
    name: "a correct payment for a sync action returns 200 with the outcome",
    async run(ctx) {
      const { id, submit } = await ctx.client.pay(ECHO.action, ECHO.input, ctx.privateKey);
      assert.equal(submit.status, 200, JSON.stringify(submit.body));
      assert.equal(submit.body.order.id, id);
      assert.equal(submit.body.order.status, "completed");
      assert.deepEqual(submit.body.outcome, { echo: ECHO.input.message });
      assert.ok(submit.headers.get("payment-response"), "PAYMENT-RESPONSE header is set");
    },
  },
  {
    name: "a Permit2 nonce cannot be spent twice",
    async run(ctx) {
      const { signed } = await ctx.client.pay(ECHO.action, ECHO.input, ctx.privateKey);
      const { id, challenge } = await newChallenge(ctx);
      const replay = signPayment(challenge, ctx.privateKey, { nonce: signed.payment.payload.permit2Authorization.nonce });
      expectRefusal(await ctx.client.submitPayment(id, replay.paymentHeader, { quoteSignature: replay.quoteSignature }), 402, "nonce_reused");
    },
  },
  {
    name: "a paid order cannot be paid again",
    async run(ctx) {
      const { id, challenge } = await ctx.client.pay(ECHO.action, ECHO.input, ctx.privateKey);
      const again = signPayment(challenge, ctx.privateKey);
      expectRefusal(await ctx.client.submitPayment(id, again.paymentHeader, { quoteSignature: again.quoteSignature }), 409, "already_paid");
    },
  },
  {
    name: "an async action returns 202, polling leaves the pending statuses and the job completes",
    async run(ctx) {
      const { id, submit } = await ctx.client.pay("implement", IMPLEMENT_INPUT, ctx.privateKey);
      assert.equal(submit.status, 202, JSON.stringify(submit.body));
      assert.equal(submit.body.order.status, "admission_pending");
      const polled = await ctx.client.poll(id);
      assert.equal(polled.status, 200);
      assert.ok(["running", "completed"].includes(polled.body.order.status), polled.body.order.status);
      const jobId = polled.body.order.jobId;
      assert.equal(typeof jobId, "string");
      let job;
      for (let i = 0; i < 10; i++) {
        job = await ctx.client.getJob(jobId);
        assert.equal(job.status, 200);
        if (job.body.job.status === "completed") break;
      }
      assert.equal(job!.body.job.status, "completed");
      assert.equal(job!.body.job.requestId, id);
    },
  },
  {
    name: "an input refused by the evaluator ends as refused after payment",
    async run(ctx) {
      const input = { ...IMPLEMENT_INPUT, objective: "Please [refuse] this objective, it is canned." };
      const { id } = await ctx.client.pay("implement", input, ctx.privateKey);
      const polled = await ctx.client.poll(id);
      assert.equal(polled.body.order.status, "refused");
      assert.ok(Array.isArray(polled.body.order.refusal.reasons));
    },
  },
  {
    name: "another bearer token cannot read the order",
    async run(ctx) {
      const quote = await ctx.client.quote(ECHO.action, ECHO.input);
      const stranger = new ImdClient(ctx.baseUrl, randomBytes(32).toString("hex"));
      assert.equal((await stranger.getRequest(quote.body.order.id)).status, 404);
    },
  },
];

export async function runConformance(
  baseUrl: string,
  { privateKey = TEST_PAYER_KEY, write = (line: string): void => void process.stdout.write(`${line}\n`) } = {},
): Promise<{ passed: number; failed: number; results: CheckResult[] }> {
  // Step 1 of the flow: a bearer token is 32 random bytes as hex.
  const ctx: Context = { client: new ImdClient(baseUrl, randomBytes(32).toString("hex")), baseUrl, privateKey };
  const results: CheckResult[] = [];
  write(`TAP version 13`);
  write(`1..${CHECKS.length}`);
  for (const [i, check] of CHECKS.entries()) {
    try {
      await check.run(ctx);
      results.push({ name: check.name, ok: true });
      write(`ok ${i + 1} - ${check.name}`);
    } catch (err) {
      const error = (err as Error).message;
      results.push({ name: check.name, ok: false, error });
      write(`not ok ${i + 1} - ${check.name}`);
      write(`  # ${error.split("\n").join("\n  # ")}`);
    }
  }
  const passed = results.filter((r) => r.ok).length;
  write(`# pass ${passed}`);
  write(`# fail ${results.length - passed}`);
  return { passed, failed: results.length - passed, results };
}
