// The conformance suite: drives a server through every step of the
// paid-request flow and checks status codes and response shapes. Run it
// against the mock (default) or any server that speaks the same API.
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { ImdClient, checkChallenge, signAuthorization, signPayment, signQuoteApproval } from "./client.js";
import { signTypedData } from "./crypto/eip712.js";
import { isAddress } from "./crypto/hex.js";
import { TEST_PAYER_KEY, testPayerKey } from "./fixtures.js";
import { IMD_TOKEN, NETWORK, PRICE_PER_ACTION, encodePaymentHeader, quoteApprovalTypedData, } from "./protocol.js";
const HEX64 = /^[0-9a-f]{64}$/;
/** A job.open body: the action every IMD client starts with. */
const JOB = {
    action: "job.open",
    input: {
        objective: "Write a short sourced note on deterministic local testing of the IMD paid-request flow.",
        skill: "research-report",
        outputs: [{ name: "report", path: "artifacts/report.md", mediaType: "text/markdown" }],
        minCitations: 5,
        github: false,
    },
};
/** schedule.topup: priced per run, and admitted inside the paid submit. */
const TOPUP = { action: "schedule.topup", input: { scheduleId: "sched_conformance", runs: 3 } };
async function newChallenge(ctx, action = JOB.action, input = JOB.input) {
    const quote = await ctx.client.quote(action, input);
    assert.equal(quote.status, 201, `quote: ${JSON.stringify(quote.body)}`);
    const challenge = await ctx.client.challenge(quote.body.order.id);
    assert.equal(challenge.status, 402);
    return { id: quote.body.order.id, challenge: challenge.body };
}
function expectRefusal(res, status, error) {
    assert.equal(res.status, status, `expected ${status} ${error}, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, error);
}
export const CHECKS = [
    {
        name: "GET /requests/capabilities lists every action with its payment terms, limits and launch chains",
        async run(ctx) {
            const res = await ctx.client.capabilities();
            assert.equal(res.status, 200);
            const c = res.body;
            assert.ok(Array.isArray(c.actions) && c.actions.length > 0, "actions is a non-empty array");
            for (const a of c.actions) {
                assert.equal(typeof a.action, "string");
                assert.equal(typeof a.version, "string");
                assert.equal(a.payment.network, NETWORK);
                assert.equal(a.payment.asset.toLowerCase(), IMD_TOKEN);
                assert.equal(a.payment.amount, PRICE_PER_ACTION);
                assert.ok(isAddress(a.payment.payTo), `${a.action} payTo is an address`);
                assert.equal(typeof a.payment.decimals, "number");
                assert.ok(Number.isInteger(a.quoteTtlSeconds) && a.quoteTtlSeconds > 0);
            }
            assert.ok(c.actions.some((a) => a.action === "job.open"), "job.open is enabled");
            assert.ok(c.launches && Array.isArray(c.launches.chains) && c.launches.chains.length > 0, "launches.chains describes launch support");
            assert.equal(typeof c.pricedPer, "object");
            ctx.capabilities = c;
        },
    },
    {
        name: "GET /openapi.json lists actions and limits under x-imd-actions",
        async run(ctx) {
            const res = await ctx.client.openapi();
            assert.equal(res.status, 200);
            const actions = res.body["x-imd-actions"];
            assert.ok(Array.isArray(actions) && actions.length > 0, "x-imd-actions is a non-empty array");
            for (const spec of actions) {
                assert.equal(typeof spec.action, "string");
                assert.ok(spec.payment, `${spec.action} has payment terms`);
                assert.ok(spec.limits, `${spec.action} has limits`);
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
            const res = await anonymous.quote(JOB.action, JOB.input);
            assert.equal(res.status, 401);
        },
    },
    {
        name: "POST /requests/check answers with action, blockers and suggestions within 3 attempts",
        async run(ctx) {
            const res = await ctx.client.check(JOB.action, JOB.input, 3);
            assert.equal(res.status, 200);
            assert.equal(res.body.action, JOB.action);
            assert.ok(Array.isArray(res.body.blockers), "blockers is an array");
            assert.equal(res.body.blockers.length, 0, JSON.stringify(res.body.blockers));
            assert.ok(Array.isArray(res.body.suggestions), "suggestions is an array");
        },
    },
    {
        name: "POST /requests/check blocks the canned [refuse] input on every attempt",
        async run(ctx) {
            const res = await ctx.client.check(JOB.action, { ...JOB.input, objective: `Please [refuse] this objective. ${JOB.input.objective}` }, 3);
            assert.equal(res.status, 200);
            assert.ok(res.body.blockers.length > 0, "a blocked input keeps its blocker on retry");
        },
    },
    {
        name: "POST /requests/quote with invalid input gets 422 invalid_input listing problems",
        async run(ctx) {
            const res = await ctx.client.quote(JOB.action, { ...JOB.input, objective: "" });
            expectRefusal(res, 422, "invalid_input");
            assert.ok(Array.isArray(res.body.problems) && res.body.problems.length > 0);
        },
    },
    {
        name: "POST /requests/quote returns {created, order} and is idempotent on requestKey",
        async run(ctx) {
            const key = randomUUID();
            const first = await ctx.client.quote(JOB.action, JOB.input, key);
            assert.equal(first.status, 201);
            assert.equal(first.body.created, true);
            const order = first.body.order;
            assert.equal(typeof order.id, "string");
            assert.equal(order.status, "quoted");
            assert.equal(order.quote.action, JOB.action);
            assert.match(order.quote.quoteHash, HEX64);
            assert.match(order.quote.inputHash, HEX64);
            assert.equal(typeof order.inputJson, "string");
            const again = await ctx.client.quote(JOB.action, JOB.input, key);
            assert.equal(again.status, 200);
            assert.equal(again.body.order.id, order.id);
        },
    },
    {
        name: "a schedule is priced per run: amount is unitAmount x runs",
        async run(ctx) {
            const quote = await ctx.client.quote(TOPUP.action, TOPUP.input);
            assert.equal(quote.status, 201, JSON.stringify(quote.body));
            const q = quote.body.order.quote;
            assert.equal(q.runs, TOPUP.input.runs);
            assert.equal(q.payment.amount, (BigInt(q.unitAmount) * BigInt(q.runs)).toString(10));
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
            assert.equal(challenge.quote.action, JOB.action);
            assert.ok(Number.isInteger(challenge.quote.expiresAt));
            assert.equal(typeof challenge.resourceUrl, "string");
            assert.equal(challenge.resource.url, challenge.resourceUrl);
            assert.match(challenge.requesterScopeHash, HEX64);
            assert.ok(challenge.input, "the challenge repeats the prepared input");
            const caps = ctx.capabilities ?? (await ctx.client.capabilities()).body;
            assert.deepEqual(checkChallenge(challenge, caps), []);
        },
    },
    {
        name: "a payment object with an extra field is refused as invalid_payment_shape",
        async run(ctx) {
            const { id, challenge } = await newChallenge(ctx);
            const signed = signPayment(challenge, ctx.privateKey);
            const header = encodePaymentHeader({ ...signed.payment, extra: "nope" });
            expectRefusal(await ctx.client.submitPayment(id, header, { quoteSignature: signed.quoteSignature }), 400, "invalid_payment_shape");
        },
    },
    {
        name: "a payment object carrying an inherited property name is refused as invalid_payment_shape",
        async run(ctx) {
            const { id, challenge } = await newChallenge(ctx);
            // `constructor` is a key of Object.prototype, not a payment field: a
            // shape check written with `in` would let it through.
            const payment = { ...signPayment(challenge, ctx.privateKey).payment, constructor: "extra" };
            const signed = signQuoteApproval(challenge, payment, ctx.privateKey);
            expectRefusal(await ctx.client.submitPayment(id, signed.paymentHeader, { quoteSignature: signed.quoteSignature }), 400, "invalid_payment_shape");
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
        name: "a correct payment for an action admitted on submit returns 200 with the admission result",
        async run(ctx) {
            const { id, submit } = await ctx.client.pay(TOPUP.action, TOPUP.input, ctx.privateKey);
            assert.equal(submit.status, 200, JSON.stringify(submit.body));
            assert.equal(submit.body.status, "admitted");
            assert.equal(submit.body.order.id, id);
            assert.equal(submit.body.order.status, "paid");
            assert.equal(submit.body.payment.paid, true);
            assert.equal(submit.body.admission.action, TOPUP.action);
            assert.equal(submit.body.admission.result.kind, "schedule");
            assert.ok(submit.headers.get("payment-response"), "PAYMENT-RESPONSE header is set");
        },
    },
    {
        name: "resending the same paid submit returns the first outcome instead of settling again",
        async run(ctx) {
            const { id, signed, submit } = await ctx.client.pay(JOB.action, JOB.input, ctx.privateKey);
            assert.ok(submit.status === 200 || submit.status === 202, JSON.stringify(submit.body));
            const again = await ctx.client.submitPayment(id, signed.paymentHeader, { quoteSignature: signed.quoteSignature });
            assert.equal(again.status, submit.status, JSON.stringify(again.body));
            assert.deepEqual(again.body, submit.body);
        },
    },
    {
        name: "a Permit2 nonce cannot be spent twice",
        async run(ctx) {
            const { signed } = await ctx.client.pay(JOB.action, JOB.input, ctx.privateKey);
            const { id, challenge } = await newChallenge(ctx);
            const replay = signPayment(challenge, ctx.privateKey, { nonce: signed.payment.payload.permit2Authorization.nonce });
            expectRefusal(await ctx.client.submitPayment(id, replay.paymentHeader, { quoteSignature: replay.quoteSignature }), 402, "nonce_reused");
        },
    },
    {
        name: "a paid order cannot be paid a second time with a different payment",
        async run(ctx) {
            const { id, challenge } = await ctx.client.pay(JOB.action, JOB.input, ctx.privateKey);
            const again = signPayment(challenge, ctx.privateKey);
            expectRefusal(await ctx.client.submitPayment(id, again.paymentHeader, { quoteSignature: again.quoteSignature }), 409, "already_paid");
        },
    },
    {
        name: "polling GET /requests/{id} reaches admitted, and admission.result points at a public job",
        async run(ctx) {
            const { id, submit } = await ctx.client.pay(JOB.action, JOB.input, ctx.privateKey);
            assert.equal(submit.status, 202, JSON.stringify(submit.body));
            assert.equal(submit.body.status, "admission_pending");
            const polled = await ctx.client.poll(id);
            assert.equal(polled.status, 200);
            assert.equal(polled.body.status, "admitted");
            assert.equal(polled.body.payment.paid, true);
            const result = polled.body.admission.result;
            assert.equal(result.kind, "job");
            assert.equal(typeof result.jobId, "string");
            assert.equal(result.statusUrl, `/jobs/${result.jobId}`);
            // The job routes are public: no Authorization header.
            const job = await fetch(new URL(result.statusUrl, ctx.baseUrl));
            assert.equal(job.status, 200, "GET /jobs/:id is public");
            assert.equal((await job.json()).id, result.jobId);
            const outcome = await fetch(new URL(result.resultUrl, ctx.baseUrl));
            assert.equal(outcome.status, 200, "GET /jobs/:id/result is public");
        },
    },
    {
        name: "another bearer token cannot read the order",
        async run(ctx) {
            const quote = await ctx.client.quote(JOB.action, JOB.input);
            const stranger = new ImdClient(ctx.baseUrl, randomBytes(32).toString("hex"));
            assert.equal((await stranger.getRequest(quote.body.order.id)).status, 404);
        },
    },
];
export async function runConformance(baseUrl, { privateKey = TEST_PAYER_KEY, write = (line) => void process.stdout.write(`${line}\n`) } = {}) {
    // Step 1 of the flow: a bearer token is 32 random bytes as hex.
    const ctx = { client: new ImdClient(baseUrl, randomBytes(32).toString("hex")), baseUrl, privateKey };
    const results = [];
    write(`TAP version 13`);
    write(`1..${CHECKS.length}`);
    for (const [i, check] of CHECKS.entries()) {
        try {
            await check.run(ctx);
            results.push({ name: check.name, ok: true });
            write(`ok ${i + 1} - ${check.name}`);
        }
        catch (err) {
            const error = err.message;
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
