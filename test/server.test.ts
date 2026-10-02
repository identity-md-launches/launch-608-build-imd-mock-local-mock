// HTTP-level behaviour of the mock: flaky mode, validation, scoping,
// polling, the banner, and the conformance suite run end to end.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ImdClient, signPayment } from "../src/client.js";
import { runConformance } from "../src/conformance.js";
import { FIXED_JOB_INPUT, TEST_BEARER_TOKEN, TEST_PAYER_KEY, testBearerToken } from "../src/fixtures.js";
import { ACTION_NAMES } from "../src/actions.js";
import { EXPERIMENTAL_NOTICE, PRICE_PER_ACTION } from "../src/protocol.js";
import { startMock } from "../src/server.js";

type Mock = Awaited<ReturnType<typeof startMock>>;
const silent = { write: () => {} };
const JOB_INPUT = FIXED_JOB_INPUT;

describe("flaky mode", () => {
  let mock: Mock;
  let client: ImdClient;
  before(async () => {
    mock = await startMock(0, "127.0.0.1", { flaky: true });
    client = new ImdClient(mock.url, TEST_BEARER_TOKEN);
  });
  after(() => mock.close());

  const check = (input: unknown, action = "job.open") => client.request("POST", "/requests/check", { action, input });

  test("blocks a body once, then accepts the same body", async () => {
    const first = await check(JOB_INPUT);
    assert.equal(first.status, 200);
    assert.equal(first.body.action, "job.open");
    assert.equal(first.body.blockers.length, 1);
    assert.equal(first.body.blockers[0].code, "evaluator_noise");
    assert.ok(Array.isArray(first.body.suggestions));
    assert.deepEqual((await check(JOB_INPUT)).body.blockers, []);
    assert.deepEqual((await check(JOB_INPUT)).body.blockers, []);
  });

  test("tracks bodies independently, ignoring key order", async () => {
    const a = { ...JOB_INPUT, objective: `${JOB_INPUT.objective} Variant A.` };
    const b = { ...JOB_INPUT, objective: `${JOB_INPUT.objective} Variant B.` };
    assert.equal((await check(a)).body.blockers.length, 1);
    assert.equal((await check(b)).body.blockers.length, 1);
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    assert.deepEqual((await check(reordered)).body.blockers, [], "the same body in another key order is already seen");
  });

  test("a client that retries up to 3 times gets the real verdict", async () => {
    const res = await client.check("job.open", { ...JOB_INPUT, objective: `${JOB_INPUT.objective} Retry me.` }, 3);
    assert.deepEqual(res.body.blockers, []);
  });

  test("a canned [refuse] blocker stays on retry", async () => {
    const res = await client.check("job.open", { ...JOB_INPUT, objective: `[refuse] ${JOB_INPUT.objective}` }, 3);
    assert.equal(res.body.blockers.at(-1).code, "canned_refusal");
  });

  test("without flaky mode the first check has no blocker", async () => {
    const plain = await startMock(0, "127.0.0.1");
    try {
      const res = await new ImdClient(plain.url, TEST_BEARER_TOKEN).request("POST", "/requests/check", { action: "job.open", input: JOB_INPUT });
      assert.deepEqual(res.body.blockers, []);
    } finally {
      await plain.close();
    }
  });
});

describe("API", () => {
  let mock: Mock;
  let client: ImdClient;
  before(async () => {
    mock = await startMock(0, "127.0.0.1");
    client = new ImdClient(mock.url, TEST_BEARER_TOKEN);
  });
  after(() => mock.close());

  test("capabilities and openapi enable every documented action", async () => {
    const caps = await client.capabilities();
    assert.equal(caps.status, 200);
    assert.deepEqual(caps.body.actions.map((a) => a.action), ACTION_NAMES);
    assert.equal(caps.body.actions[0].payment.amount, PRICE_PER_ACTION);
    assert.deepEqual(caps.body.pricedPer, { "schedule.create": "run", "schedule.topup": "run" });
    const openapi = await client.openapi();
    assert.deepEqual((openapi.body["x-imd-actions"] as any[]).map((a) => a.action), ACTION_NAMES);
    assert.equal(openapi.body["x-imd-quote-approval"].primaryType, "QuoteApproval");
  });

  test("every documented action can be quoted", async () => {
    const inputs: Record<string, unknown> = {
      "job.open": JOB_INPUT,
      "job.continue": { ...JOB_INPUT, parentJobId: "a-parent-job" },
      "launch.open": { objective: "Launch a fixed-supply token for the mock's test suite.", onchain: "evm_project" },
      "workflow.open": {
        request: "Build a token with tests and a review, deploy it, then publish a site against the live address.",
        draft: { objective: "Build, review and deploy, then build the site.", shape: "chain", onchain: "evm_project", steps: [{ skill: "build-contract-project" }] },
        permissions: { github: true, onchain: { kind: "evm_project", chainId: 11155111 } },
      },
      "oracle.request": {
        v: 1,
        question: "Did the mock answer this question deterministically?",
        chainId: 1,
        window: { hours: 24 },
        answerType: "bool",
        panelSize: 5,
        quorum: 3,
        validForSeconds: 3600,
      },
      "schedule.create": { action: "job.open", input: JOB_INPUT, cadence: { every: "P1D" }, runs: 7 },
      "schedule.topup": { scheduleId: "sched_test", runs: 2 },
    };
    for (const action of ACTION_NAMES) {
      const res = await client.quote(action, inputs[action]);
      assert.equal(res.status, 201, `${action}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.order.quote.action, action);
    }
  });

  test("a schedule costs its price times the runs it buys", async () => {
    const res = await client.quote("schedule.create", { action: "job.open", input: JOB_INPUT, cadence: { every: "PT6H" }, runs: 4 });
    const quote = res.body.order.quote;
    assert.equal(quote.runs, 4);
    assert.equal(quote.unitAmount, PRICE_PER_ACTION);
    assert.equal(quote.payment.amount, (BigInt(PRICE_PER_ACTION) * 4n).toString(10));
  });

  test("quote validation lists every problem", async () => {
    const res = await client.request("POST", "/requests/quote", {
      requestKey: "nope",
      action: "job.open",
      input: { objective: "", baseCommit: "abc", onchain: true, projectId: "p1" },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "invalid_input");
    const paths = res.body.problems.map((p: { path: string }) => p.path).sort();
    assert.deepEqual(paths, ["input.baseCommit", "input.objective", "input.onchain", "input.projectId", "input.repoUrl", "requestKey"]);
  });

  test("unknown action is invalid_input and names the catalogue", async () => {
    const res = await client.quote("launch-rocket", {});
    assert.equal(res.status, 422);
    assert.equal(res.body.problems[0].path, "action");
    assert.ok(res.body.problems[0].message.includes("job.open"));
  });

  test("an input the evaluator blocks is 422 before any payment", async () => {
    const res = await client.quote("job.open", { ...JOB_INPUT, objective: `[refuse] ${JOB_INPUT.objective}` });
    assert.equal(res.status, 422);
    assert.equal(res.body.blockers[0].code, "canned_refusal");
  });

  test("reusing a requestKey with a different input is a 409", async () => {
    const key = randomUUID();
    assert.equal((await client.quote("job.open", JOB_INPUT, key)).status, 201);
    const res = await client.quote("job.open", { ...JOB_INPUT, minCitations: 6 }, key);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "request_key_conflict");
  });

  test("the 402 challenge is also sent base64-encoded in PAYMENT-REQUIRED", async () => {
    const quote = await client.quote("job.open", JOB_INPUT);
    const res = await client.challenge(quote.body.order.id);
    assert.equal(res.status, 402);
    const header = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString("utf8"));
    assert.deepEqual(header, res.body);
  });

  test("polling reports status, order, payment and admission, and reaches admitted", async () => {
    const quote = await client.quote("job.open", JOB_INPUT);
    const id = quote.body.order.id;
    assert.equal(quote.body.created, true);
    assert.equal((await client.getRequest(id)).body.status, "quoted");
    const challenge = (await client.challenge(id)).body;
    assert.equal((await client.getRequest(id)).body.status, "payment_pending");
    const signed = signPayment(challenge, TEST_PAYER_KEY);
    const submit = await client.submitPayment(id, signed.paymentHeader, { quoteSignature: signed.quoteSignature });
    assert.equal(submit.status, 202);

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) seen.push((await client.getRequest(id)).body.status);
    assert.deepEqual(seen, ["admission_pending", "admitted", "admitted"]);

    const status = (await client.getRequest(id)).body;
    assert.equal(status.order.status, "paid");
    assert.equal(status.payment!.paid, true);
    assert.match(status.payment!.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.equal(status.admission!.action, "job.open");
    const result = status.admission!.result as Record<string, string>;
    assert.equal(result.kind, "job");
    assert.equal(result.statusUrl, `/jobs/${result.jobId}`);
  });

  test("the job routes are public and need no bearer token", async () => {
    const { id } = await client.pay("job.open", JOB_INPUT, TEST_PAYER_KEY);
    const result = (await client.poll(id)).body.admission!.result as Record<string, string>;
    const job = await fetch(`${mock.url}${result.statusUrl}`);
    assert.equal(job.status, 200);
    const body = (await job.json()) as { id: string; state: string };
    assert.equal(body.id, result.jobId);
    assert.ok(["executing", "completed"].includes(body.state), body.state);
    const outcome = (await (await fetch(`${mock.url}${result.resultUrl}`)).json()) as { jobId: string };
    assert.equal(outcome.jobId, result.jobId);
  });

  test("an input marked [stale] is admitted and then refused", async () => {
    const { id } = await client.pay("job.open", { ...JOB_INPUT, objective: `[stale] ${JOB_INPUT.objective}` }, TEST_PAYER_KEY);
    const polled = await client.poll(id);
    assert.equal(polled.body.status, "admitted");
    assert.equal((polled.body.admission!.result as Record<string, unknown>).kind, "refused");
  });

  test("orders are scoped to the bearer token", async () => {
    const quote = await client.quote("job.open", JOB_INPUT);
    const id = quote.body.order.id;
    const other = new ImdClient(mock.url, testBearerToken(1));
    assert.equal((await other.getRequest(id)).status, 404);
    assert.equal((await other.challenge(id)).status, 404);
  });

  test("bearer tokens must be 32 bytes of hex", async () => {
    const res = await new ImdClient(mock.url, "abc").getRequest("00000000-0000-4000-8000-000000000000");
    assert.equal(res.status, 401);
  });

  test("browser origins are refused, including preflight", async () => {
    for (const method of ["GET", "OPTIONS"]) {
      const res = await fetch(`${mock.url}/requests/capabilities`, { method, headers: { origin: "http://localhost:3000" } });
      assert.equal(res.status, 403);
    }
  });

  test("import is canned and offline", async () => {
    const res = await client.request("POST", "/requests/import", { url: "https://github.com/example/widget.git", kind: "code" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.source.repoUrl, "https://github.com/example/widget");
    assert.match(res.body.source.baseCommit, /^[0-9a-f]{40}$/);
  });

  test("the home page carries the experimental banner", async () => {
    const html = await (await fetch(mock.url)).text();
    assert.ok(html.includes(EXPERIMENTAL_NOTICE));
  });
});

describe("conformance suite", () => {
  test("passes against the mock", async () => {
    const mock = await startMock(0, "127.0.0.1");
    try {
      const { failed, results } = await runConformance(mock.url, silent);
      assert.equal(failed, 0, JSON.stringify(results.filter((r) => !r.ok), null, 2));
    } finally {
      await mock.close();
    }
  });

  test("passes against the mock in flaky mode", async () => {
    const mock = await startMock(0, "127.0.0.1", { flaky: true });
    try {
      const { failed, results } = await runConformance(mock.url, silent);
      assert.equal(failed, 0, JSON.stringify(results.filter((r) => !r.ok), null, 2));
    } finally {
      await mock.close();
    }
  });
});

describe("CLI", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

  test("--help shows the experimental notice and the catalogue", () => {
    const out = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.ok(out.includes(EXPERIMENTAL_NOTICE));
    assert.ok(out.includes("job.open"));
  });

  test("conformance runs with one command and exits 0", () => {
    const out = execFileSync(process.execPath, [cli, "conformance"], { encoding: "utf8" });
    assert.match(out, /# fail 0/);
  });
});
