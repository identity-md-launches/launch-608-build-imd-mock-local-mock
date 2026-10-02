import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { resolve } from "node:path";
import { startMock } from "../src/server.js";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

function handCommands(readme: string): string {
  const match = /Try it by hand:\n\n```sh\n([\s\S]*?)```/.exec(readme);
  assert.ok(match, "README must have a Try it by hand shell block");
  return match[1];
}

test("README hand commands run against the mock", async () => {
  const [readme, liveCapabilitiesText, liveCheckText] = await Promise.all([
    readFile(resolve(ROOT, "README.md"), "utf8"),
    readFile(resolve(ROOT, "test/fixtures/live/capabilities.json"), "utf8"),
    readFile(resolve(ROOT, "test/fixtures/live/check-job-open.json"), "utf8"),
  ]);
  const commands = handCommands(readme);
  const liveCapabilities = JSON.parse(liveCapabilitiesText) as { actions: Array<{ action: string }> };
  const liveCheck = JSON.parse(liveCheckText) as Record<string, unknown>;

  assert.doesNotMatch(readme, /\b(?:echo|implement)\b/i);
  assert.match(readme, /\{action, blockers, suggestions, kind, plan, facts, judged\}/);
  assert.match(readme, /Known open question:[\s\S]*payment_pending[\s\S]*unconfirmed/);

  const mock = await startMock(0, "127.0.0.1");
  try {
    await execFileAsync("bash", ["-eu", "-o", "pipefail", "-c", commands], {
      env: { ...process.env, BASE_URL: mock.url },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    const capabilities = (await (await fetch(`${mock.url}/requests/capabilities`)).json()) as { actions: Array<{ action: string }> };
    const check = (await (
      await fetch(`${mock.url}/requests/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "job.open", input: { objective: "Say hi." } }),
      })
    ).json()) as Record<string, unknown>;

    assert.deepEqual(
      new Set(capabilities.actions.map(({ action }) => action)),
      new Set(liveCapabilities.actions.map(({ action }) => action)),
    );
    assert.equal(check.action, "job.open");
    assert.deepEqual(Object.keys(check).sort(), Object.keys(liveCheck).sort());
  } finally {
    await mock.close();
  }
});

test("README conformance commands pass", async () => {
  const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
  const match = /## Conformance suite\n\n```sh\n([\s\S]*?)```/.exec(readme);
  assert.ok(match, "README must have a Conformance suite shell block");

  const mock = await startMock(0, "127.0.0.1");
  try {
    const commands = match[1].replace("http://127.0.0.1:8402", mock.url);
    const { stdout } = await execFileAsync("bash", ["-eu", "-o", "pipefail", "-c", commands], {
      cwd: ROOT,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
    });
    assert.equal((stdout.match(/^# fail 0$/gm) ?? []).length, 3);
  } finally {
    await mock.close();
  }
});

test("README library example runs", async () => {
  const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
  const match = /## Use as a library\n\n```ts\n([\s\S]*?)```/.exec(readme);
  assert.ok(match, "README must have a Use as a library TypeScript block");

  await execFileAsync(process.execPath, ["--input-type=module", "-e", `${match[1]}\nif (!id || submit.status !== 202) throw new Error("library example did not submit a job");`], {
    cwd: ROOT,
    timeout: 10_000,
  });
});
