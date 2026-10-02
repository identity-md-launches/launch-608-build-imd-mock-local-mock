#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ACTION_NAMES } from "./actions.js";
import { runConformance } from "./conformance.js";
import { MOCK_PAY_TO, TEST_BEARER_TOKEN, TEST_PAYER_ADDRESS, TEST_PAYER_KEY } from "./fixtures.js";
import { EXPERIMENTAL_NOTICE } from "./protocol.js";
import { startMock } from "./server.js";
import { buildVectors } from "./vectors.js";
const HELP = `imd-mock: a local mock of the IMD paid-request API.

${EXPERIMENTAL_NOTICE}

It is a mock: no IMD moves, nothing is settled onchain, actions are canned.

Usage:
  imd-mock [serve] [options]        start the mock (default port 8402)
  imd-mock conformance [options]    run the conformance suite; starts its own
                                    mock unless --url is given
  imd-mock vectors                  print the deterministic test vectors (JSON)

Options:
  -p, --port <n>            port to listen on (serve; 0 = any free port)
  -H, --host <addr>         address to bind (default 127.0.0.1)
      --flaky               /requests/check adds an evaluator-noise blocker to
                            each distinct body once, then answers normally
      --quote-ttl <s>       quote lifetime in seconds (default 600)
      --public-url <url>    base URL to put in resourceUrl (default: from Host)
      --url <url>           conformance: server to test instead of a fresh mock
  -q, --quiet               serve: do not log requests
  -h, --help                show this help
  -v, --version             show the version

Actions (the catalogue the live API enables):
  ${ACTION_NAMES.join(", ")}

Test identities (public, never fund them):
  bearer token  ${TEST_BEARER_TOKEN}
  payer key     ${TEST_PAYER_KEY}
  payer address ${TEST_PAYER_ADDRESS}
  mock payTo    ${MOCK_PAY_TO}
`;
async function main(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            port: { type: "string", short: "p" },
            host: { type: "string", short: "H", default: "127.0.0.1" },
            flaky: { type: "boolean", default: false },
            "quote-ttl": { type: "string" },
            "public-url": { type: "string" },
            url: { type: "string" },
            quiet: { type: "boolean", short: "q", default: false },
            help: { type: "boolean", short: "h", default: false },
            version: { type: "boolean", short: "v", default: false },
        },
    });
    const command = positionals[0] ?? "serve";
    if (values.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (values.version) {
        process.stdout.write("imd-mock 0.1.0\n");
        return 0;
    }
    const quoteTtlSeconds = values["quote-ttl"] === undefined ? undefined : Number(values["quote-ttl"]);
    if (quoteTtlSeconds !== undefined && !(Number.isInteger(quoteTtlSeconds) && quoteTtlSeconds > 10)) {
        throw new Error("--quote-ttl must be an integer number of seconds above 10");
    }
    const options = { flaky: values.flaky, quoteTtlSeconds, publicUrl: values["public-url"] };
    if (command === "vectors") {
        process.stdout.write(`${JSON.stringify(buildVectors(), null, 2)}\n`);
        return 0;
    }
    if (command === "conformance") {
        process.stdout.write(`# ${EXPERIMENTAL_NOTICE}\n`);
        if (values.url) {
            const { failed } = await runConformance(values.url);
            return failed === 0 ? 0 : 1;
        }
        const mock = await startMock(0, "127.0.0.1", options);
        try {
            process.stdout.write(`# against a fresh mock at ${mock.url}${values.flaky ? " (flaky)" : ""}\n`);
            const { failed } = await runConformance(mock.url);
            return failed === 0 ? 0 : 1;
        }
        finally {
            await mock.close();
        }
    }
    if (command === "serve") {
        const port = values.port === undefined ? Number(process.env.PORT ?? 8402) : Number(values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
            throw new Error("--port must be 0-65535");
        const log = values.quiet ? undefined : (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
        const mock = await startMock(port, values.host, { ...options, log });
        process.stdout.write(`${EXPERIMENTAL_NOTICE}\n\n`);
        process.stdout.write(`imd-mock listening on ${mock.url}${values.flaky ? " (flaky check mode)" : ""}\n`);
        process.stdout.write(`This is a mock: no IMD moves and nothing is settled. Ctrl-C to stop.\n`);
        const stop = () => void mock.close().then(() => process.exit(0));
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        return new Promise(() => { }); // run until signalled
    }
    process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
    return 2;
}
main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`imd-mock: ${err.message}\n`);
    process.exit(2);
});
