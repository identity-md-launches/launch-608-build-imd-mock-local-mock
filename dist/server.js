// The mock IMD paid-request API: an in-memory node:http server.
import { createServer } from "node:http";
import { ACTIONS, actionsExtension, cannedVerdict, validateRequest } from "./actions.js";
import { toChecksumAddress } from "./crypto/hex.js";
import { MOCK_PAY_TO } from "./fixtures.js";
import { CHAIN_ID, DEADLINE_MARGIN_SECONDS, EXPERIMENTAL_NOTICE, IMD_DECIMALS, IMD_TOKEN, NETWORK, PERMIT2_ADDRESS, PRICE_PER_ACTION, X402_PERMIT2_PROXY, canonicalJson, sha256Hex, } from "./protocol.js";
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
export class MockState {
    options;
    orders = new Map();
    jobs = new Map();
    requestKeys = new Map();
    usedNonces = new Set();
    flakySeen = new Set();
    flaky;
    quoteLifetimeSeconds;
    payTo;
    now;
    constructor(options = {}) {
        this.options = options;
        this.flaky = options.flaky ?? false;
        this.quoteLifetimeSeconds = options.quoteLifetimeSeconds ?? 600;
        this.payTo = toChecksumAddress(options.payTo ?? MOCK_PAY_TO);
        this.now = options.now ?? Date.now;
    }
    nowSeconds() {
        return Math.floor(this.now() / 1000);
    }
    accepts() {
        return {
            scheme: "exact",
            network: NETWORK,
            amount: PRICE_PER_ACTION,
            asset: IMD_TOKEN,
            payTo: this.payTo,
            maxTimeoutSeconds: this.quoteLifetimeSeconds,
            extra: { assetTransferMethod: "permit2", name: "IMD", version: "1" },
        };
    }
    capabilities() {
        return {
            mock: true,
            notice: EXPERIMENTAL_NOTICE,
            x402Version: 2,
            chainId: CHAIN_ID,
            network: NETWORK,
            asset: IMD_TOKEN,
            assetSymbol: "IMD",
            assetDecimals: IMD_DECIMALS,
            price: PRICE_PER_ACTION,
            priceUnit: "per action (per run for schedules)",
            payTo: this.payTo,
            quoteLifetimeSeconds: this.quoteLifetimeSeconds,
            deadlineMarginSeconds: DEADLINE_MARGIN_SECONDS,
            permit2: PERMIT2_ADDRESS,
            spender: X402_PERMIT2_PROXY,
            launchChains: [{ chainId: CHAIN_ID, network: NETWORK, name: "Ethereum" }],
            actions: Object.keys(ACTIONS),
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
            info: { title: "imd-mock", version: "0.1.0", description: `Local mock of the IMD paid-request API. ${EXPERIMENTAL_NOTICE}` },
            paths: {
                "/requests/capabilities": { get: op("Price, asset, payTo, quote lifetime, launch chains", ["200"]) },
                "/requests/check": { post: op("Canned evaluator verdict, no payment", ["200", "422"]) },
                "/requests/import": { post: op("Canned import of a public GitHub repo", ["200", "422"]) },
                "/requests/quote": { post: op("Create a quoted order", ["200", "201", "401", "409", "422"]) },
                "/requests/{id}/submit": { post: op("402 challenge, or a paid submit", ["200", "202", "400", "402", "404", "409", "410"]) },
                "/requests/{id}": { get: op("Order status", ["200", "404"]) },
                "/jobs/{id}": { get: op("Job status", ["200", "404"]) },
            },
            "x-imd-actions": actionsExtension(this.quoteLifetimeSeconds),
        };
    }
    check(body) {
        const problems = validateRequest(body.action, body.input);
        if (problems.length > 0)
            throw invalidInput(problems);
        if (this.flaky) {
            const key = sha256Hex(canonicalJson({ action: body.action, input: body.input }));
            if (!this.flakySeen.has(key)) {
                this.flakySeen.add(key);
                return { verdict: "refuse", reasons: ["evaluator noise (flaky mode): the same body will be accepted on retry"] };
            }
        }
        return cannedVerdict(body.input);
    }
    importRepo(body) {
        const m = typeof body.url === "string" ? /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(\.git)?\/?$/.exec(body.url) : null;
        if (!m)
            throw invalidInput([{ path: "url", message: "must be a public https://github.com/<owner>/<repo> URL" }]);
        if (body.kind !== undefined && body.kind !== "repo")
            throw invalidInput([{ path: "kind", message: 'must be "repo"' }]);
        const repoUrl = `https://github.com/${m[1]}/${m[2]}`;
        // Canned: the mock never fetches anything, so the commit is a stable fake.
        return { repoUrl, baseCommit: sha256Hex(repoUrl).slice(0, 40), mock: true };
    }
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
        const input = body.input;
        const existingId = this.requestKeys.get(`${scope}:${requestKey}`);
        if (existingId) {
            const existing = this.orders.get(existingId);
            if (existing.action !== action || canonicalJson(existing.input) !== canonicalJson(input)) {
                throw new HttpError(409, "request_key_conflict", "requestKey was already used with a different action or input");
            }
            return { status: 200, order: existing };
        }
        const id = `req_${sha256Hex(`${scope}:${requestKey}`).slice(0, 24)}`;
        const now = this.nowSeconds();
        const expiresAt = now + this.quoteLifetimeSeconds;
        const resourceUrl = `${baseUrl}/requests/${id}/submit`;
        const payment = { asset: IMD_TOKEN, amount: PRICE_PER_ACTION, payTo: this.payTo };
        const quoteId = `q_${sha256Hex(`quote:${id}`).slice(0, 24)}`;
        const quote = {
            id: quoteId,
            quoteHash: sha256Hex(canonicalJson({ quoteId, requestId: id, action, input, payment, expiresAt, scope, resourceUrl })),
            action,
            payment,
            expiresAt,
        };
        const challenge = {
            x402Version: 2,
            error: "payment_required",
            accepts: [this.accepts()],
            quote,
            resource: { url: resourceUrl, description: `IMD paid action: ${action}`, mimeType: "application/json" },
            resourceUrl,
            requesterScopeHash: scope,
        };
        const order = { id, scope, requestKey, action, input, status: "quoted", challenge, createdAt: now, updatedAt: now };
        this.orders.set(id, order);
        this.requestKeys.set(`${scope}:${requestKey}`, id);
        return { status: 201, order };
    }
    order(scope, id) {
        const order = this.orders.get(id);
        if (!order || order.scope !== scope)
            throw new HttpError(404, "not_found", "no such request for this bearer token");
        if ((order.status === "quoted" || order.status === "payment_pending") && this.nowSeconds() >= order.challenge.quote.expiresAt) {
            this.setStatus(order, "expired");
        }
        return order;
    }
    setStatus(order, status) {
        order.status = status;
        order.updatedAt = this.nowSeconds();
    }
    submit(scope, id, paymentHeader, body) {
        const order = this.order(scope, id);
        if (order.status === "expired")
            throw new HttpError(410, "quote_expired", "the quote has expired; request a new quote");
        if (order.status !== "quoted" && order.status !== "payment_pending") {
            throw new HttpError(409, "already_paid", `request is ${order.status}`, { order: this.orderView(order) });
        }
        if (paymentHeader === undefined) {
            this.setStatus(order, "payment_pending");
            return { status: 402, body: order.challenge, headers: { "payment-required": b64(order.challenge) } };
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
        // The mock settles nothing; the "transaction" is a stable fake hash.
        const transaction = `0x${sha256Hex(`settle:${result.payer.toLowerCase()}:${result.nonce}`)}`;
        order.payment = { payer: result.payer, nonce: result.nonce, paymentHash: result.paymentHash, transaction };
        const settlement = b64({ success: true, transaction, network: NETWORK, payer: result.payer });
        const spec = ACTIONS[order.action];
        if (spec.completion === "sync") {
            this.admit(order);
            return { status: 200, body: { order: this.orderView(order), outcome: order.outcome ?? null }, headers: { "payment-response": settlement } };
        }
        this.setStatus(order, "admission_pending");
        return { status: 202, body: { order: this.orderView(order) }, headers: { "payment-response": settlement } };
    }
    /** Runs the canned admission verdict: completes sync actions, queues a job for async ones. */
    admit(order) {
        const verdict = cannedVerdict(order.input);
        if (verdict.verdict === "refuse") {
            order.refusal = { reasons: verdict.reasons };
            this.setStatus(order, "refused");
            return;
        }
        const spec = ACTIONS[order.action];
        if (spec.completion === "sync") {
            order.outcome = spec.outcome(order.input);
            this.setStatus(order, "completed");
            return;
        }
        const now = this.nowSeconds();
        const job = { id: `job_${sha256Hex(`job:${order.id}`).slice(0, 24)}`, requestId: order.id, action: order.action, status: "queued", createdAt: now, updatedAt: now };
        this.jobs.set(job.id, job);
        order.jobId = job.id;
        this.setStatus(order, "running");
    }
    /**
     * Each read advances an async order one step, so polling is deterministic:
     * admission_pending -> running (job queued) -> job running -> completed.
     */
    advance(order) {
        if (order.status === "admission_pending")
            return this.admit(order);
        if (order.status !== "running" || !order.jobId)
            return;
        const job = this.jobs.get(order.jobId);
        job.updatedAt = this.nowSeconds();
        if (job.status === "queued") {
            job.status = "running";
            return;
        }
        job.status = "completed";
        job.result = ACTIONS[order.action].outcome(order.input);
        order.outcome = job.result;
        this.setStatus(order, "completed");
    }
    getRequest(scope, id) {
        const order = this.order(scope, id);
        const view = this.orderView(order);
        this.advance(order);
        return { order: view };
    }
    getJob(scope, id) {
        const job = this.jobs.get(id);
        const order = job && this.orders.get(job.requestId);
        if (!job || !order || order.scope !== scope)
            throw new HttpError(404, "not_found", "no such job for this bearer token");
        const view = { ...job };
        this.advance(order);
        return { job: view };
    }
    orderView(order) {
        const { challenge } = order;
        return {
            id: order.id,
            requestKey: order.requestKey,
            action: order.action,
            status: order.status,
            quote: challenge.quote,
            resourceUrl: challenge.resourceUrl,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            ...(order.payment ? { payment: { payer: order.payment.payer, transaction: order.payment.transaction, network: NETWORK } } : {}),
            ...(order.jobId ? { jobId: order.jobId } : {}),
            ...(order.outcome ? { outcome: order.outcome } : {}),
            ...(order.refusal ? { refusal: order.refusal } : {}),
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
<li><code>GET /jobs/{id}</code></li>
</ul></body></html>
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
            const baseUrl = options.publicUrl ?? `http://${req.headers.host ?? "localhost"}`;
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
                const { status, order } = state.quote(scope, objectBody(await readJson(req)), baseUrl.replace(/\/+$/, ""));
                return send(res, status, { order: state.orderView(order) });
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
            if (method === "GET" && (m = /^\/jobs\/([^/]+)$/.exec(path))) {
                return send(res, 200, state.getJob(scopeOf(req), decodeURIComponent(m[1])));
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
