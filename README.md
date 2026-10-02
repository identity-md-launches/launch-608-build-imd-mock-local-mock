# imd-mock

> **Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.**

**imd-mock is a mock.** It runs the IMD paid-request API (`https://api.imd.fun/requests/...`) on your
machine so you can build and test a client without spending IMD. It checks your signatures the way
the flow describes, but no IMD moves, nothing is settled onchain, and every action outcome is canned.

It gives you:

- an HTTP server with the routes of the paid-request flow;
- strict verification of the x402 v2 Permit2 payment and the EIP-712 `QuoteApproval` (it recovers
  the signer and checks every field);
- deterministic test keys and a committed set of test vectors (`fixtures/vectors.json`);
- a conformance suite you run with one command;
- a reference TypeScript client (`src/client.ts`) that does the whole flow.

It needs Node 20 or newer and has no runtime dependencies.

## Five-minute start

```sh
# From a clone, start the mock on http://127.0.0.1:8402. dist/ is committed, so no build is needed.
npm start
npm run conformance            # starts its own mock and runs the suite: "# fail 0" means all good
```

Point your client at `http://127.0.0.1:8402` instead of `https://api.imd.fun`. Sign with the test payer
key below. When your client gets a `200` or `202` from the paid submit, its signing is right.

Try it by hand:

```sh
BASE_URL=${BASE_URL:-http://127.0.0.1:8402}
TOKEN=$(openssl rand -hex 32) # step 1: bearer token = 32 random bytes as hex
curl -fsS "$BASE_URL/requests/capabilities"; printf '\n'
curl -fsS -X POST "$BASE_URL/requests/check" -H 'content-type: application/json' \
  -d '{"action":"job.open","input":{"objective":"Say hi."}}'; printf '\n'
ORDER=$(curl -fsS -X POST "$BASE_URL/requests/quote" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"requestKey\":\"$(node -p 'crypto.randomUUID()')\",\"action\":\"job.open\",\"input\":{\"objective\":\"Say hi.\"}}")
ORDER_ID=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).order.id)' "$ORDER")
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/requests/$ORDER_ID/submit" -H "Authorization: Bearer $TOKEN")
test "$STATUS" = 402 # payment challenge; steps 5 to 7 need signatures
```

Steps 5 to 7 need signatures; see `signPayment` in [`src/client.ts`](src/client.ts) for a complete,
dependency-free implementation, and `fixtures/vectors.json` for exact bytes to compare against.

## Command line

```
imd-mock [serve] [options]        start the mock (default port 8402, or $PORT)
imd-mock conformance [options]    run the conformance suite; starts its own mock unless --url is given
imd-mock vectors                  print the deterministic test vectors (JSON)

  -p, --port <n>            port to listen on (0 = any free port)
  -H, --host <addr>         address to bind (default 127.0.0.1)
      --flaky               /requests/check adds a blocker to each distinct body once, then answers normally
      --quote-lifetime <s>  quote lifetime in seconds (default 600)
      --public-url <url>    base URL to put in resourceUrl (default: http://<Host header>)
      --url <url>           conformance: server to test instead of a fresh mock
  -q, --quiet               do not log requests
  -h, --help / -v, --version
```

`imd-mock --help` prints the same experimental notice as the top of this file, and so does the page the
server serves at `/`.

## The mock flow

| Step | Request | Mock response |
| --- | --- | --- |
| 1 | Make a bearer token: 32 random bytes as hex | Any other token is `401 unauthorized` |
| 2 | `POST /requests/quote {requestKey, action, input}` | `201 {order:{id, status:"quoted", quote, ...}}`; same `requestKey` and body again is `200` with the same order; same key with a different body is `409 request_key_conflict`; bad input is `422 {error:"invalid_input", problems:[{path, message}]}` |
| 3 | `POST /requests/{id}/submit`, no body, no payment | `402 {x402Version:2, accepts[], quote{id, quoteHash, action, payment{asset, amount, payTo}, expiresAt}, resource, resourceUrl, requesterScopeHash}`, also base64 in the `PAYMENT-REQUIRED` header |
| 4 | Check `accepts[0]` against capabilities and the quote | `checkChallenge()` in `src/client.ts` does this |
| 5 | Sign Permit2 `PermitWitnessTransferFrom` | Verified on submit (below) |
| 6 | Sign `QuoteApproval` | Verified on submit (below) |
| 7 | `POST /requests/{id}/submit` with `PAYMENT-SIGNATURE: base64(JSON payment)` and body `{quoteSignature}` | `job.open`: `202 {status:"admission_pending", ...}`. `schedule.create` and `schedule.topup` are admitted immediately and return `200 {status:"admitted", ...}`. All set a base64 `PAYMENT-RESPONSE` header with a fake transaction hash |
| 8 | Poll `GET /requests/{id}` with the same bearer | `{order:{...}}`; see the state machine below |

Free helpers: `POST /requests/check {action, input}` returns
`{action, blockers, suggestions, kind, plan, facts, judged}` (with action-specific extra fields possible);
`POST /requests/import {url, kind}` returns `{ok, mock, source:{repoUrl, baseCommit, ...}}`; `GET /openapi.json` lists actions
and limits under `x-imd-actions`; `GET /requests/capabilities` gives price, asset, payTo, quote lifetime
and launch chains. `GET /jobs/{id}` returns `{id, state, objective, ...}`.

Every request that carries an `Origin` header (that is, comes from a browser, preflight included) gets
`403 browser_origin_forbidden`. Orders can only be read with the bearer token that created them; any
other token gets `404`. Jobs are public.

### What the paid submit checks

The `PAYMENT-SIGNATURE` header must decode to exactly this object. Numbers are decimal strings, and
any extra or missing field anywhere gives `400 invalid_payment_shape`:

```json
{ "x402Version": 2, "resource": { "url": "", "description": "", "mimeType": "" }, "accepted": { "...": "accepts[0], verbatim" },
  "payload": { "signature": "0x...",
    "permit2Authorization": { "from": "0x...", "permitted": { "token": "0x...", "amount": "..." },
      "spender": "0x...", "nonce": "...", "deadline": "...", "witness": { "to": "0x...", "validAfter": "0" } } } }
```

Then, in order (each refusal is `402` with the challenge repeated plus `error`, `message` and `field`):

| Check | Error |
| --- | --- |
| `x402Version` is 2; `resource` equals the challenge's; `accepted` equals `accepts[0]` | `payment_mismatch` |
| `permitted.token` = quote asset, `permitted.amount` = quote amount, `spender` = `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`, `witness.to` = payTo, `witness.validAfter` = 0 | `payment_mismatch` |
| `deadline` ≤ `quote.expiresAt − 5` | `deadline_too_late` |
| `deadline` is still in the future | `permit_expired` |
| The Permit2 signature (domain `Permit2`, chainId 1, verifyingContract `0x000000000022D473030F116dDEE9F6B43aC78BA3`) recovers to `from` | `invalid_payment_signature` |
| The `(from, nonce)` pair has not been used before | `nonce_reused` |
| Body is exactly `{quoteSignature}` | `400 invalid_body` |
| The `QuoteApproval` signature (domain `IdentityMD Paid Action`, version 1, chainId 1) recovers to `from`, where the server rebuilds the approval from its own quote and `paymentHash` = sha256 of the key-sorted JSON payment | `invalid_quote_signature` |

Other submit outcomes: `410 quote_expired` once the quote has expired, `409 already_paid` if the order
was already paid. A refused payment changes nothing: the order stays payable and the nonce is not used.

### State machine

The mock has no timers. Every transition happens because a client made a request, so tests are
deterministic. This is who moves each transition:

| From | To | Triggered by |
| --- | --- | --- |
| (none) | `quoted` | client: `POST /requests/quote` |
| `quoted` | `payment_pending` | client: unpaid `POST /requests/{id}/submit` (the 402) |
| `quoted` / `payment_pending` | `expired` | any read or submit after `expiresAt` |
| `payment_pending` | `admission_pending` | client: valid paid submit of `job.open`, `job.continue`, `launch.open`, `workflow.open`, or `oracle.request` |
| `payment_pending` | `admitted` | client: valid paid submit of `schedule.create` or `schedule.topup` |
| `admission_pending` | `admitted` | client: next `GET /requests/{id}` or `GET /jobs/{id}`; a created job advances from `executing` to `completed` on a later read |

In the real service settlement, admission and the job run on the server's own schedule. Here, polling
drives them.

**Known open question:** the mock moves an order to `payment_pending` when an unpaid submit returns
`402`; whether the live server does the same is unconfirmed.

## Canned behaviour

- **Actions** (in `src/actions.ts`, listed under `x-imd-actions`): these stand in for the real
  catalogue. `job.open {objective}` returns `202` and is admitted on the next read; schedule actions
  are admitted in the paid submit (`200`).
- **Checks:** any input string containing `[refuse]` receives a `canned_refusal` blocker from
  `/requests/check`, and quoting the same input returns `422`. Other valid inputs have no canned blocker.
- **Flaky mode** (`--flaky`): `/requests/check` adds an `evaluator_noise` blocker to each distinct
  `{action, input}` body (keys sorted) the first time it sees it. A retry gets the normal check result.
- **Import:** `/requests/import` fetches nothing. `baseCommit` is a stable fake derived from the URL.

## Test identities and vectors

All of these are public and derived from fixed labels (`src/fixtures.ts`). **Never fund them.**

| | Value |
| --- | --- |
| Payer private key, `keccak256("imd-mock/payer/0")` | `0x849d0232281d21e9ddd59555fec0c9553d3af72d9ee19fe94e6347b7818a962f` |
| Payer address | `0xEA0755C631cC6004b81d55c2b0c76187A82323A6` |
| Bearer token, `sha256("imd-mock/bearer/0")` | `33ce3b7e480acd19edf5c795a97c88938d5571a14b66ad6d6e1a83215e2f78be` |
| Mock payTo (not the real IMD payTo) | `0x8dC3ADe127Bd4Ef8e60008B0e20b7E075B71A432` |

`fixtures/vectors.json` holds one complete paid submit at a fixed clock with a fixed nonce: the
challenge, the payment object and its canonical JSON, the `PAYMENT-SIGNATURE` header, both encoded
types, typed-data digests and signatures. A client in any language can check its bytes against it.
The signatures and digests were cross-checked against viem 2.x when the file was generated, and
`npm test` fails if the code stops reproducing them. The mock defines `requesterScopeHash` as
sha256 of the bearer token's hex string.

## Conformance suite

```sh
npm run conformance                                  # fresh mock, in-process
node dist/cli.js conformance --flaky                 # against a flaky mock
node dist/cli.js conformance --url http://127.0.0.1:8402  # against a server that is already running
```

It prints TAP and exits non-zero on any failure. It covers 20 checks: capabilities and openapi shapes,
browser-origin and bearer rules, check blockers with retry, quote validation and idempotency, the
402 challenge shape and its agreement with capabilities, the payment-shape, mismatch, deadline,
forged-signature and wrong-`paymentHash` refusals, successful paid submits, nonce replay, double
payment, polling through to a completed job, admission refusal, and bearer scoping. The checks
live in `src/conformance.ts`. To check a client you wrote, run it against the mock: the mock refuses
anything the suite refuses.

Do not run it against `https://api.imd.fun`. It expects the mock's canned actions and test keys, and
on a real server a payment would be real.

## Use as a library

```ts
import { startMock, ImdClient, TEST_PAYER_KEY } from "imd-mock";

const mock = await startMock(0, "127.0.0.1", { flaky: true });   // port 0 picks a free port
const client = new ImdClient(mock.url, "<64 hex chars>");
const { id, submit } = await client.pay("job.open", { objective: "Say hi." }, TEST_PAYER_KEY);
await mock.close();
```

`MockState` gives direct, HTTP-free access with an injectable clock (`now`), which is how the payment
tests in `test/payment.test.ts` run.

## What the mock does not reproduce

- **No chain.** No token balance, no IMD allowance to Permit2, no Permit2 nonce bitmap onchain, no
  settlement transaction. The `transaction` in `PAYMENT-RESPONSE` and in the order is a fake hash. A
  wallet with no IMD or no approval is accepted here and would fail for real.
- **Not the real catalogue or prices.** The seven action names and every 0.5 IMD base price are local
  stand-ins. Schedule actions are priced per run in the mock.
- **Not the real payTo.** Payments go to the mock payTo above. Read the real one from the real
  `/requests/capabilities`.
- **No real evaluator.** Verdicts are canned (`[refuse]` marker). The real evaluator's noise is only
  approximated by `--flaky`. Nothing is built, reviewed or launched, and outcomes are canned.
- **No timers.** Statuses advance when polled, not with time. Only quote expiry uses the clock.
- **Mock-defined details.** These follow the flow description, but the exact values may differ from
  the real service: response fields beyond those the flow names, error codes and HTTP status codes
  for refusals, how `quoteHash`, `requesterScopeHash` and ids are derived, `accepts[0].extra`
  contents, and `maxTimeoutSeconds`.
- **No rate limits, no persistence** (state lives in memory and is lost on restart), and no TLS.
- **No refunds** on a refused order, and no `https://imd.fun/docs#paid` pages beyond what is
  summarised here.
- **High-s signatures are accepted** (like `ecrecover`). The reference client always produces low-s.
- The in-house secp256k1 code is not constant-time. It only ever handles published test keys, so do
  not reuse it for real keys.

## Project layout

```
src/
  cli.ts            command line (serve, conformance, vectors)
  server.ts         the mock: routes, in-memory state, state machine
  verify.ts         paid-submit verification (shape, fields, both signatures)
  protocol.ts       constants, payment types, EIP-712 domains and types, paymentHash
  client.ts         reference client: signing and the whole flow
  conformance.ts    the conformance suite
  actions.ts        canned action catalogue and verdicts
  fixtures.ts       deterministic test keys
  vectors.ts        builds fixtures/vectors.json
  crypto/           keccak256, secp256k1 (sign/recover), EIP-712 hashing; no dependencies
test/               node:test suites (npm test)
fixtures/vectors.json
dist/               compiled output, committed so `npx github:` runs without a build step
vendor/npm/         tarballs of the dev dependencies (typescript, @types/node) so installs work offline
```

## Development

```sh
npm ci            # installs typescript and @types/node from vendor/npm, no network needed
npm test          # type-checks src and test, then runs 80 tests (payment, flaky, API, CLI, conformance)
npm run compile   # rebuild dist/ after changing src/ (commit dist/ with the change)
npm run vectors   # regenerate fixtures/vectors.json after an intentional protocol change
```

The build script is called `compile`, not `build`, on purpose. If a package has a `build` or `prepare`
script, `npx github:` installs its dev dependencies and builds it, which is slower and needs the
network. Without one, npx runs the committed `dist/` as it is.

## Licence

MIT. See [LICENSE](LICENSE).

Commissioned through paid IMD swarm requests.
