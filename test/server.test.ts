// HTTP-level behaviour of the mock: flaky mode, validation, scoping,
// polling, the banner, and the conformance suite run end to end.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ImdClient, signPayment } from "../src/client.js";
import { runConformance } from "../src/conformance.js";
import { TEST_BEARER_TOKEN, TEST_PAYER_KEY, testBearerToken } from "../src/fixtures.js";
import { EXPERIMENTAL_NOTICE } from "../src/protocol.js";
import { startMock } from "../src/server.js";

type Mock = Awaited<ReturnType<typeof startMock>>;
const silent = { write: () => {} };
const ECHO_INPUT = { message: "flaky test" };

describe("flaky mode", () => {
  let mock: Mock;
  let client: ImdClient;
  before(async () => {
    mock = await startMock(0, "127.0.0.1", { flaky: true });
    client = new ImdClient(mock.url, TEST_BEARER_TOKEN);
  });
  after(() => mock.close());

  test("refuses a body once, then accepts the same body", async () => {
    const first = await client.request("POST", "/requests/check", { action: "echo", input: ECHO_INPUT });
    assert.equal(first.status, 200);
    assert.equal(first.body.verdict, "refuse");
    const second = await client.request("POST", "/requests/check", { action: "echo", input: ECHO_INPUT });
    assert.equal(second.body.verdict, "accept");
    const third = await client.request("POST", "/requests/check", { action: "echo", input: ECHO_INPUT });
    assert.equal(third.body.verdict, "accept");
  });

  test("tracks bodies independently, ignoring key order", async () => {
    const a = { message: "body A" };
    assert.equal((await client.request("POST", "/requests/check", { action: "echo", input: a })).body.verdict, "refuse");
    const b = { message: "body B" };
    assert.equal((await client.request("POST", "/requests/check", { action: "echo", input: b })).body.verdict, "refuse");
    assert.equal((await client.request("POST", "/requests/check", { input: a, action: "echo" })).body.verdict, "accept");
  });

  test("a client that retries up to 3 times gets the real verdict", async () => {
    const res = await client.check("echo", { message: "retry me" }, 3);
    assert.equal(res.body.verdict, "accept");
  });

  test("a canned refusal stays refused on retry", async () => {
    const res = await client.check("echo", { message: "[refuse] me" }, 3);
    assert.equal(res.body.verdict, "refuse");
    assert.match(res.body.reasons[0], /canned refusal/);
  });

  test("without flaky mode the first check is the real verdict", async () => {
    const plain = await startMock(0, "127.0.0.1");
    try {
      const res = await new ImdClient(plain.url, TEST_BEARER_TOKEN).request("POST", "/requests/check", { action: "echo", input: ECHO_INPUT });
      assert.equal(res.body.verdict, "accept");
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

  test("quote validation lists every problem", async () => {
    const res = await client.request("POST", "/requests/quote", {
      requestKey: "nope",
      action: "implement",
      input: { repoUrl: "ftp://x", baseCommit: "abc", objective: "short", extra: 1 },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "invalid_input");
    const paths = res.body.problems.map((p: { path: string }) => p.path).sort();
    assert.deepEqual(paths, ["input.baseCommit", "input.extra", "input.objective", "input.repoUrl", "requestKey"]);
  });

  test("unknown action is invalid_input", async () => {
    const res = await client.quote("launch-rocket", {});
    assert.equal(res.status, 422);
    assert.equal(res.body.problems[0].path, "action");
  });

  test("reusing a requestKey with a different input is a 409", async () => {
    const key = randomUUID();
    assert.equal((await client.quote("echo", { message: "a" }, key)).status, 201);
    const res = await client.quote("echo", { message: "b" }, key);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "request_key_conflict");
  });

  test("the 402 challenge is also sent base64-encoded in PAYMENT-REQUIRED", async () => {
    const quote = await client.quote("echo", { message: "hi" });
    const res = await client.challenge(quote.body.order.id);
    assert.equal(res.status, 402);
    const header = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString("utf8"));
    assert.deepEqual(header, res.body);
  });

  test("statuses: payment_pending after the challenge, admission_pending after paying, then running and completed", async () => {
    const quote = await client.quote("implement", {
      repoUrl: "https://github.com/example/widget",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      objective: "Exercise every status transition of the mock.",
    });
    const id = quote.body.order.id;
    assert.equal(quote.body.order.status, "quoted");
    await client.challenge(id);
    assert.equal((await client.getRequest(id)).body.order.status, "payment_pending");
    const challenge = (await client.challenge(id)).body;
    const signed = signPayment(challenge, TEST_PAYER_KEY);
    const submit = await client.submitPayment(id, signed.paymentHeader, { quoteSignature: signed.quoteSignature });
    assert.equal(submit.status, 202);
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push((await client.getRequest(id)).body.order.status);
    assert.deepEqual(seen, ["admission_pending", "running", "running", "completed"]);
    const order = (await client.getRequest(id)).body.order;
    assert.equal(order.payment.payer, signed.payment.payload.permit2Authorization.from);
    const job = await client.getJob(order.jobId);
    assert.equal(job.body.job.status, "completed");
    assert.equal(job.body.job.result.repoUrl, "https://github.com/example/widget");
  });

  test("orders and jobs are scoped to the bearer token", async () => {
    const { id } = await client.pay("implement", {
      repoUrl: "https://github.com/example/widget",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      objective: "Scoping test for jobs and requests.",
    }, TEST_PAYER_KEY);
    const jobId = (await client.poll(id)).body.order.jobId;
    const other = new ImdClient(mock.url, testBearerToken(1));
    assert.equal((await other.getRequest(id)).status, 404);
    assert.equal((await other.getJob(jobId)).status, 404);
    assert.equal((await other.challenge(id)).status, 404);
  });

  test("bearer tokens must be 32 bytes of hex", async () => {
    const res = await new ImdClient(mock.url, "abc").getRequest("req_x");
    assert.equal(res.status, 401);
  });

  test("browser origins are refused, including preflight", async () => {
    for (const method of ["GET", "OPTIONS"]) {
      const res = await fetch(`${mock.url}/requests/capabilities`, { method, headers: { origin: "http://localhost:3000" } });
      assert.equal(res.status, 403);
    }
  });

  test("import is canned and offline", async () => {
    const res = await client.request("POST", "/requests/import", { url: "https://github.com/example/widget.git", kind: "repo" });
    assert.equal(res.status, 200);
    assert.equal(res.body.repoUrl, "https://github.com/example/widget");
    assert.match(res.body.baseCommit, /^[0-9a-f]{40}$/);
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
      const { failed } = await runConformance(mock.url, silent);
      assert.equal(failed, 0);
    } finally {
      await mock.close();
    }
  });
});

describe("CLI", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

  test("--help shows the experimental notice", () => {
    const out = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    assert.ok(out.includes(EXPERIMENTAL_NOTICE));
  });

  test("conformance runs with one command and exits 0", () => {
    const out = execFileSync(process.execPath, [cli, "conformance"], { encoding: "utf8" });
    assert.match(out, /# fail 0/);
  });
});
