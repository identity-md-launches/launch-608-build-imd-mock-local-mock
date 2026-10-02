// The mock IMD paid-request API: an in-memory node:http server.
import { createServer } from "node:http";
import { ACTIONS, ACTION_NAMES, STALE_MARKER, actionsExtension, cannedBlockers, cannedSuggestions, hasMarker, limitsExtension, pricedPerExtension, validateRequest, } from "./actions.js";
import { MOCK_PAY_TO } from "./fixtures.js";
import { DEFAULT_QUOTE_TTL_SECONDS, EXPERIMENTAL_NOTICE, IMD_DECIMALS, IMD_TOKEN, MAX_TIMEOUT_SECONDS, NETWORK, PRICE_PER_ACTION, QUOTE_APPROVAL_DOMAIN, QUOTE_APPROVAL_TYPES, canonicalJson, sha256Hex, uuidFrom, } from "./protocol.js";
import { verifyPaidSubmit } from "./verify.js";
export class HttpError extends Error {
    status;
    code;
    extra;
    constructor(status, code, message, extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN = /^[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO = (ms) => new Date(ms).toISOString();
export class MockState {
    options;
    orders = new Map();
    jobs = new Map();
    requestKeys = new Map();
    usedNonces = new Set();
    flakySeen = new Set();
    flaky;
    quoteTtlSeconds;
    payTo;
    now;
    constructor(options = {}) {
        this.options = options;
        this.flaky = options.flaky ?? false;
        this.quoteTtlSeconds = options.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
        this.payTo = (options.payTo ?? MOCK_PAY_TO).toLowerCase();
        this.now = options.now ?? Date.now;
    }
    nowSeconds() {
        return Math.floor(this.now() / 1000);
    }
    accepts(amount) {
        return {
            scheme: "exact",
            network: NETWORK,
            asset: IMD_TOKEN,
            amount,
            payTo: this.payTo,
            maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
            extra: { assetTransferMethod: "permit2" },
        };
    }
    capabilities() {
        return {
            mock: true,
            notice: EXPERIMENTAL_NOTICE,
            actions: actionsExtension(this.quoteTtlSeconds, this.payTo, false),
            limits: limitsExtension(),
            launches: {
                defaultChainId: 11155111,
                chains: [
                    {
                        chainId: 11155111,
                        name: "Sepolia",
                        testnet: true,
                        kinds: ["univ4_hook", "evm_project", "custom_token"],
                        pairings: [
                            {
                                pairWith: "eth",
                                currency: "0x0000000000000000000000000000000000000000",
                                symbol: "ETH",
                                name: "Sepolia Ether",
                                decimals: 18,
                                kinds: ["univ4_hook", "evm_project", "custom_token"],
                            },
                        ],
                    },
                ],
            },
            pricedPer: pricedPerExtension(),
            authentication: { scheme: "Bearer", tokenBytes: 32, encoding: "hex", creator: "client" },
            payment: { x402Version: 2, scheme: "exact", assetTransferMethod: "permit2", quoteApproval: "EIP-712" },
        };
    }
    openapi() {
        const json = { "application/json": { schema: { type: "object" } } };
        const op = (summary, codes) => ({
            summary,
            responses: Object.fromEntries(codes.map((c) => [c, { description: c, content: json }])),
        });
        return {
            openapi: "3.1.0",
            info: {
                title: "imd-mock",
                version: "0.1.0",
                description: `Local mock of the IMD paid-request API. ${EXPERIMENTAL_NOTICE}`,
            },
            "x-imd-mock": true,
            "x-imd-actions": actionsExtension(this.quoteTtlSeconds, this.payTo, true),
            "x-imd-quote-approval": {
                domain: { ...QUOTE_APPROVAL_DOMAIN },
                primaryType: "QuoteApproval",
                types: QUOTE_APPROVAL_TYPES,
            },
            paths: {
                "/requests/capabilities": { get: op("Enabled actions, limits, launch chains and payment method", ["200"]) },
                "/requests/check": { post: op("Canned evaluator preflight: blockers and suggestions, no payment", ["200", "422"]) },
                "/requests/import": { post: op("Canned import of a public GitHub repository", ["200", "422"]) },
                "/requests/quote": { post: op("Validate input and save a priced order", ["200", "201", "401", "409", "422"]) },
                "/requests/{id}/submit": { post: op("402 challenge, or a paid submit", ["200", "202", "400", "402", "404", "409", "410"]) },
                "/requests/{id}": { get: op("Order status: {status, order, payment, admission}", ["200", "401", "404"]) },
                "/jobs/{id}": { get: op("The canned job behind an admitted order", ["200", "404"]) },
                "/jobs/{id}/result": { get: op("The canned job result", ["200", "404"]) },
            },
        };
    }
    /** POST /requests/check: {action, blockers, suggestions} plus the action's preview. */
    check(body) {
        const problems = validateRequest(body.action, body.input);
        if (problems.length > 0)
            throw invalidInput(problems);
        const action = body.action;
        const input = body.input;
        const blockers = [];
        if (this.flaky) {
            const key = sha256Hex(canonicalJson({ action, input }));
            if (!this.flakySeen.has(key)) {
                this.flakySeen.add(key);
                blockers.push({ code: "evaluator_noise", detail: "evaluator noise (flaky mode): the same body has no blocker on retry" });
            }
        }
        blockers.push(...cannedBlockers(input));
        return { action, ...ACTIONS[action].preview(input), blockers, suggestions: cannedSuggestions(input) };
    }
    /** POST /requests/import: canned, and never reaches the network. */
    importRepo(body) {
        const m = typeof body.url === "string" ? /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(\.git)?(\/tree\/([^/\s]+))?\/?$/.exec(body.url) : null;
        if (!m)
            throw invalidInput([{ path: "url", message: "must be a public https://github.com/<owner>/<repo> URL" }]);
        if (body.kind !== undefined && !["site", "contracts", "code"].includes(body.kind)) {
            throw invalidInput([{ path: "kind", message: "must be one of: site, contracts, code" }]);
        }
        const repoUrl = `https://github.com/${m[1]}/${m[2]}`;
        const ref = m[5] ?? "main";
        // The mock fetches nothing, so the commit is a stable fake derived from the URL.
        return {
            ok: true,
            mock: true,
            source: { repoUrl, baseCommit: sha256Hex(`${repoUrl}#${ref}`).slice(0, 40), ref, sizeKb: 0, site: body.kind === "site" },
        };
    }
    /** POST /requests/quote. */
    quote(scope, body, baseUrl) {
        const problems = [];
        if (typeof body.requestKey !== "string" || !UUID.test(body.requestKey)) {
            problems.push({ path: "requestKey", message: "must be a UUID" });
        }
        problems.push(...validateRequest(body.action, body.input));
        if (problems.length > 0)
            throw invalidInput(problems);
        const requestKey = body.requestKey.toLowerCase();
        const action = body.action;
        const spec = ACTIONS[action];
        const input = spec.prepare(body.input);
        const blockers = cannedBlockers(input);
        if (blockers.length > 0) {
            throw new HttpError(422, "invalid_input", "the evaluator blocked this request", {
                problems: blockers.map((b) => ({ path: "input", message: b.detail })),
                blockers,
            });
        }
        const existingId = this.requestKeys.get(`${scope}:${requestKey}`);
        if (existingId) {
            const existing = this.orders.get(existingId);
            if (existing.action !== action || canonicalJson(existing.input) !== canonicalJson(input)) {
                throw new HttpError(409, "request_key_conflict", "requestKey was already used with a different action or input");
            }
            return { status: 200, order: existing };
        }
        const id = uuidFrom(`imd-mock/order/${scope}/${requestKey}`);
        const nowMs = this.now();
        const issuedAt = Math.floor(nowMs / 1000);
        const units = spec.units(input);
        const amount = (BigInt(PRICE_PER_ACTION) * BigInt(units)).toString(10);
        const quoteFields = {
            v: 1,
            id,
            action,
            policyVersion: spec.version,
            inputHash: sha256Hex(canonicalJson(input)),
            issuedAt,
            expiresAt: issuedAt + this.quoteTtlSeconds,
            payment: {
                network: NETWORK,
                asset: IMD_TOKEN,
                amount,
                payTo: this.payTo,
                decimals: IMD_DECIMALS,
                scheme: "exact",
            },
            ...(spec.pricedPer ? { unitAmount: PRICE_PER_ACTION, runs: units } : {}),
            terms: { purchase: "action-admission", resultGuaranteed: false },
        };
        // quoteHash commits to every field of the quote except itself.
        const quote = { ...quoteFields, quoteHash: sha256Hex(canonicalJson(quoteFields)) };
        const resourceUrl = `${baseUrl}/requests/${id}`;
        const challenge = {
            x402Version: 2,
            resource: { url: resourceUrl, description: `One ${action} request`, mimeType: "application/json" },
            accepts: [this.accepts(amount)],
            quote,
            requesterScopeHash: scope,
            resourceUrl,
            input,
        };
        const order = {
            id,
            scope,
            requestKey,
            action,
            input,
            quote,
            challenge,
            status: "quoted",
            createdAt: nowMs,
            paidAt: null,
        };
        this.orders.set(id, order);
        this.requestKeys.set(`${scope}:${requestKey}`, id);
        return { status: 201, order };
    }
    record(scope, id) {
        const order = this.orders.get(id);
        if (!order || order.scope !== scope)
            throw new HttpError(404, "not_found", "no such request for this bearer token");
        if ((order.status === "quoted" || order.status === "payment_pending") && this.nowSeconds() >= order.quote.expiresAt) {
            order.status = "expired";
        }
        return order;
    }
    /** POST /requests/{id}/submit, with or without the PAYMENT-SIGNATURE header. */
    submit(scope, id, paymentHeader, body) {
        const order = this.record(scope, id);
        if (paymentHeader === undefined) {
            if (order.status === "expired")
                throw new HttpError(410, "quote_expired", "the quote has expired; request a new quote");
            if (order.status === "quoted" || order.status === "payment_pending") {
                order.status = "payment_pending";
                return { status: 402, body: order.challenge, headers: { "payment-required": b64(order.challenge) } };
            }
            throw new HttpError(409, "already_paid", `request is ${this.statusOf(order)}`, { order: this.orderView(order) });
        }
        // The same submit bytes again: the documented recovery when a response is
        // lost. It returns the first outcome and settles nothing a second time.
        const replayKey = sha256Hex(`${paymentHeader.trim()}\n${canonicalJson(body)}`);
        if (order.replay?.key === replayKey) {
            return { ...order.replay, headers: { ...order.replay.headers, "payment-replayed": "true" } };
        }
        if (order.status === "expired")
            throw new HttpError(410, "quote_expired", "the quote has expired; request a new quote");
        if (order.status !== "quoted" && order.status !== "payment_pending") {
            throw new HttpError(409, "already_paid", `request is ${this.statusOf(order)}; resend the same payment bytes to re-read its outcome`, {
                order: this.orderView(order),
            });
        }
        const result = verifyPaidSubmit({
            challenge: order.challenge,
            paymentHeader,
            body,
            nowSeconds: this.nowSeconds(),
            isNonceUsed: (payer, nonce) => this.usedNonces.has(`${payer.toLowerCase()}:${nonce}`),
        });
        if (!result.ok) {
            const extra = result.field ? { field: result.field } : {};
            if (result.status === 400)
                throw new HttpError(400, result.error, result.message, extra);
            const failure = { ...order.challenge, error: result.error, message: result.message, ...extra };
            return { status: 402, body: failure, headers: { "payment-required": b64(order.challenge) } };
        }
        this.usedNonces.add(`${result.payer.toLowerCase()}:${result.nonce}`);
        // The mock settles nothing; the transaction hash is a stable fake.
        const transactionHash = `0x${sha256Hex(`settle:${result.payer.toLowerCase()}:${result.nonce}`)}`;
        order.payment = { payer: result.payer, nonce: result.nonce, paymentHash: result.paymentHash, transactionHash };
        order.status = "paid";
        order.paidAt = this.now();
        const headers = {
            "payment-response": b64({ success: true, transaction: transactionHash, network: NETWORK, payer: result.payer }),
        };
        if (ACTIONS[order.action].admitsOnSubmit)
            this.admit(order);
        const response = {
            key: replayKey,
            status: order.admission ? 200 : 202,
            body: this.statusView(order),
            headers,
        };
        order.replay = response;
        return { status: response.status, body: response.body, headers };
    }
    /** Runs the canned admission: an order moves from admission_pending to admitted. */
    admit(order) {
        if (order.admission)
            return;
        const spec = ACTIONS[order.action];
        if (hasMarker(order.input, STALE_MARKER)) {
            order.admission = {
                action: order.action,
                result: {
                    kind: "refused",
                    problems: [{ code: "catalog_changed", detail: `the mock refuses any input containing ${STALE_MARKER} at admission` }],
                },
            };
            return;
        }
        const ids = {
            jobId: uuidFrom(`imd-mock/job/${order.id}`),
            workflowId: uuidFrom(`imd-mock/workflow/${order.id}`),
            oracleRequestId: uuidFrom(`imd-mock/oracle/${order.id}`),
            scheduleId: uuidFrom(`imd-mock/schedule/${order.id}`),
        };
        const result = spec.result(ids, order.input);
        order.admission = { action: order.action, result };
        const jobId = typeof result.jobId === "string" ? result.jobId : undefined;
        if (jobId) {
            const nowMs = this.now();
            this.jobs.set(jobId, {
                id: jobId,
                requestId: order.id,
                state: "executing",
                template: typeof order.input.shape === "string" ? `shape:${order.input.shape}` : order.input.template ?? null,
                objective: typeof order.input.objective === "string" ? order.input.objective : `One ${order.action} request`,
                paidBy: order.payment?.payer.toLowerCase() ?? "",
                parentJobId: order.input.parentJobId ?? null,
                createdAt: nowMs,
                updatedAt: nowMs,
            });
            order.jobId = jobId;
        }
    }
    /**
     * The mock has no timers, so every read advances the work one step:
     * admission_pending -> admitted (job executing) -> job completed.
     */
    advance(order) {
        if (order.status !== "paid")
            return;
        if (!order.admission)
            return this.admit(order);
        const job = order.jobId ? this.jobs.get(order.jobId) : undefined;
        if (job && job.state === "executing") {
            job.state = "completed";
            job.updatedAt = this.now();
        }
    }
    statusOf(order) {
        if (order.status !== "paid")
            return order.status;
        return order.admission ? "admitted" : "admission_pending";
    }
    /** GET /requests/{id}. */
    getRequest(scope, id) {
        const order = this.record(scope, id);
        const view = this.statusView(order);
        this.advance(order);
        return view;
    }
    /** GET /jobs/{id}: public, like the live route. */
    getJob(id) {
        const job = this.jobs.get(id);
        if (!job)
            throw new HttpError(404, "not_found", "no such job");
        const view = this.jobView(job);
        const order = this.orders.get(job.requestId);
        if (order)
            this.advance(order);
        return view;
    }
    /** GET /jobs/{id}/result. */
    getJobResult(id) {
        const job = this.jobs.get(id);
        if (!job)
            throw new HttpError(404, "not_found", "no such job");
        const complete = job.state === "completed";
        const view = {
            jobId: job.id,
            projectId: job.id,
            state: job.state,
            complete,
            mock: true,
            source: [],
            files: complete
                ? [
                    {
                        name: "summary",
                        path: "artifacts/summary.md",
                        mediaType: "text/markdown",
                        hash: sha256Hex(`imd-mock/result/${job.id}`),
                        bytes: 0,
                        submissionHash: sha256Hex(`imd-mock/submission/${job.id}`),
                        url: `/artifacts/${sha256Hex(`imd-mock/result/${job.id}`)}`,
                    },
                ]
                : [],
            delivery: null,
        };
        const order = this.orders.get(job.requestId);
        if (order)
            this.advance(order);
        return view;
    }
    orderView(order) {
        return {
            id: order.id,
            requestKey: order.requestKey,
            status: order.status,
            paidAt: order.paidAt === null ? null : ISO(order.paidAt),
            quote: order.quote,
            inputJson: canonicalJson(order.input),
            createdAt: ISO(order.createdAt),
        };
    }
    statusView(order) {
        return {
            status: this.statusOf(order),
            order: this.orderView(order),
            payment: order.payment
                ? { status: "confirmed", paid: true, transactionHash: order.payment.transactionHash, payer: order.payment.payer, network: NETWORK }
                : null,
            admission: order.admission ?? null,
        };
    }
    jobView(job) {
        return {
            id: job.id,
            state: job.state,
            template: job.template,
            objective: job.objective,
            blockedReason: null,
            createdAt: ISO(job.createdAt),
            updatedAt: ISO(job.updatedAt),
            paidBy: job.paidBy,
            parentJobId: job.parentJobId,
            mock: true,
            project: { id: job.id, head: job.state === "completed" ? job.id : null, running: job.state === "completed" ? null : job.id, versions: [] },
            delivery: null,
            nodes: [{ key: "build", state: job.state, attempt: 1, verdict: job.state === "completed" ? "accepted" : null }],
        };
    }
}
function invalidInput(problems) {
    return new HttpError(422, "invalid_input", "the request is invalid", { problems });
}
function b64(value) {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
            throw new HttpError(413, "body_too_large", `body exceeds ${MAX_BODY_BYTES} bytes`);
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (text === "")
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        throw new HttpError(400, "invalid_json", "body is not valid JSON");
    }
}
function objectBody(body) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new HttpError(400, "invalid_body", "body must be a JSON object");
    }
    return body;
}
/** requesterScopeHash: sha256 of the bearer token (lowercase hex), as hex. */
function scopeOf(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!m || !TOKEN.test(m[1])) {
        throw new HttpError(401, "unauthorized", "Authorization: Bearer <32 random bytes as hex> is required");
    }
    return sha256Hex(m[1].toLowerCase());
}
function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(text);
}
function homePage() {
    const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>imd-mock</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
.banner{background:#fff4d6;border:2px solid #c98a00;padding:.75rem 1rem;border-radius:6px}
code{background:#f2f2f2;padding:0 .25rem}</style></head>
<body><p class="banner" role="alert"><strong>${escape(EXPERIMENTAL_NOTICE)}</strong></p>
<h1>imd-mock</h1>
<p>A local <strong>mock</strong> of the IMD paid-request API. No IMD moves; nothing is built. Signatures are checked as the real flow describes.</p>
<ul>
<li><code>GET /requests/capabilities</code></li>
<li><code>GET /openapi.json</code></li>
<li><code>POST /requests/check</code></li>
<li><code>POST /requests/import</code></li>
<li><code>POST /requests/quote</code></li>
<li><code>POST /requests/{id}/submit</code></li>
<li><code>GET /requests/{id}</code></li>
<li><code>GET /jobs/{id}</code> and <code>GET /jobs/{id}/result</code></li>
</ul>
<p>Actions: ${ACTION_NAMES.map((a) => `<code>${a}</code>`).join(", ")}.</p>
</body></html>
`;
}
export function createMockServer(options = {}) {
    const state = new MockState(options);
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = req.method ?? "GET";
        res.on("finish", () => options.log?.(`${method} ${url.pathname} ${res.statusCode}`));
        try {
            if (method === "GET" && path === "/") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(homePage());
                return;
            }
            // The API is server-side only: any browser origin (including preflight) is refused.
            if (req.headers.origin !== undefined) {
                throw new HttpError(403, "browser_origin_forbidden", "the paid-request API is server-side only");
            }
            const baseUrl = (options.publicUrl ?? `http://${req.headers.host ?? "localhost"}`).replace(/\/+$/, "");
            let m;
            if (method === "GET" && path === "/requests/capabilities")
                return send(res, 200, state.capabilities());
            if (method === "GET" && path === "/openapi.json")
                return send(res, 200, state.openapi());
            if (method === "POST" && path === "/requests/check")
                return send(res, 200, state.check(objectBody(await readJson(req))));
            if (method === "POST" && path === "/requests/import")
                return send(res, 200, state.importRepo(objectBody(await readJson(req))));
            if (method === "POST" && path === "/requests/quote") {
                const scope = scopeOf(req);
                const { status, order } = state.quote(scope, objectBody(await readJson(req)), baseUrl);
                return send(res, status, { created: status === 201, order: state.orderView(order) });
            }
            if (method === "POST" && (m = /^\/requests\/([^/]+)\/submit$/.exec(path))) {
                const scope = scopeOf(req);
                const header = req.headers["payment-signature"];
                const body = await readJson(req);
                const result = state.submit(scope, decodeURIComponent(m[1]), Array.isArray(header) ? header[0] : header, body);
                return send(res, result.status, result.body, result.headers);
            }
            if (method === "GET" && (m = /^\/requests\/([^/]+)$/.exec(path))) {
                return send(res, 200, state.getRequest(scopeOf(req), decodeURIComponent(m[1])));
            }
            if (method === "GET" && (m = /^\/jobs\/([^/]+)\/result$/.exec(path))) {
                return send(res, 200, state.getJobResult(decodeURIComponent(m[1])));
            }
            if (method === "GET" && (m = /^\/jobs\/([^/]+)$/.exec(path))) {
                return send(res, 200, state.getJob(decodeURIComponent(m[1])));
            }
            throw new HttpError(404, "not_found", `no route for ${method} ${path}`);
        }
        catch (err) {
            if (err instanceof HttpError)
                return send(res, err.status, { error: err.code, message: err.message, ...err.extra });
            options.log?.(`internal error: ${err.stack ?? err}`);
            return send(res, 500, { error: "internal_error", message: "unexpected mock error" });
        }
    });
    return { server, state };
}
/** Starts the mock and resolves once it is listening. Port 0 picks a free port. */
export async function startMock(port = 0, host = "127.0.0.1", options = {}) {
    const { server, state } = createMockServer(options);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
    });
    const address = server.address();
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
    return {
        url,
        port: address.port,
        state,
        server,
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        }),
    };
}
