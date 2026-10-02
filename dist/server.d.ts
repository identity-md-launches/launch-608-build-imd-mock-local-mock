import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Note } from "./actions.js";
import { type AdmissionResult, type Order, type OrderStatus, type PaymentChallenge, type PaymentRequirements, type Quote, type RequestStatus, type RequestStatusResponse } from "./protocol.js";
export interface MockOptions {
    /** Add an evaluator-noise blocker to each distinct /requests/check body once. */
    flaky?: boolean;
    /** Clock in milliseconds. Default Date.now. */
    now?: () => number;
    quoteTtlSeconds?: number;
    payTo?: string;
    /** Public base URL used in resourceUrl. Default: http://<Host header>. */
    publicUrl?: string;
    /** Called with one line per request; default silent. */
    log?: (line: string) => void;
}
interface JobRecord {
    id: string;
    requestId: string;
    state: "executing" | "completed";
    template: string | null;
    objective: string;
    paidBy: string;
    parentJobId: string | null;
    createdAt: number;
    updatedAt: number;
}
interface Replay {
    key: string;
    status: number;
    body: unknown;
    headers: Record<string, string>;
}
interface OrderRecord {
    id: string;
    scope: string;
    requestKey: string;
    action: string;
    input: Record<string, unknown>;
    quote: Quote;
    challenge: PaymentChallenge;
    status: OrderStatus;
    createdAt: number;
    paidAt: number | null;
    payment?: {
        payer: string;
        nonce: string;
        paymentHash: string;
        transactionHash: string;
    };
    admission?: {
        action: string;
        result: AdmissionResult;
    };
    jobId?: string;
    /** The exact bytes of the submit that settled, so a lost response can be re-read. */
    replay?: Replay;
}
export declare class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    readonly extra: Record<string, unknown>;
    constructor(status: number, code: string, message: string, extra?: Record<string, unknown>);
}
export declare class MockState {
    readonly options: MockOptions;
    readonly orders: Map<string, OrderRecord>;
    readonly jobs: Map<string, JobRecord>;
    readonly requestKeys: Map<string, string>;
    readonly usedNonces: Set<string>;
    readonly flakySeen: Set<string>;
    readonly flaky: boolean;
    readonly quoteTtlSeconds: number;
    readonly payTo: string;
    readonly now: () => number;
    constructor(options?: MockOptions);
    nowSeconds(): number;
    accepts(amount: string): PaymentRequirements;
    capabilities(): {
        mock: boolean;
        notice: string;
        actions: Record<string, unknown>[];
        limits: Record<string, Record<string, number>>;
        launches: {
            defaultChainId: number;
            chains: {
                chainId: number;
                name: string;
                testnet: boolean;
                kinds: string[];
                pairings: {
                    pairWith: string;
                    currency: string;
                    symbol: string;
                    name: string;
                    decimals: number;
                    kinds: string[];
                }[];
            }[];
        };
        pricedPer: Record<string, string>;
        authentication: {
            scheme: string;
            tokenBytes: number;
            encoding: string;
            creator: string;
        };
        payment: {
            x402Version: number;
            scheme: string;
            assetTransferMethod: string;
            quoteApproval: string;
        };
    };
    openapi(): {
        openapi: string;
        info: {
            title: string;
            version: string;
            description: string;
        };
        "x-imd-mock": boolean;
        "x-imd-actions": Record<string, unknown>[];
        "x-imd-quote-approval": {
            domain: {
                name: "IdentityMD Paid Action";
                version: "1";
                chainId: 1;
            };
            primaryType: string;
            types: import("./crypto/eip712.js").TypedDataTypes;
        };
        paths: {
            "/requests/capabilities": {
                get: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            "/requests/check": {
                post: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            "/requests/import": {
                post: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            "/requests/quote": {
                post: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            "/requests/{id}/submit": {
                post: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            "/requests/{id}": {
                get: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            "/jobs/{id}": {
                get: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
            "/jobs/{id}/result": {
                get: {
                    summary: string;
                    responses: {
                        [k: string]: {
                            description: string;
                            content: {
                                "application/json": {
                                    schema: {
                                        type: string;
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
    };
    /** POST /requests/check: {action, blockers, suggestions} plus the action's preview. */
    check(body: Record<string, unknown>): {
        blockers: Note[];
        suggestions: Note[];
        action: string;
    };
    /** POST /requests/import: canned, and never reaches the network. */
    importRepo(body: Record<string, unknown>): {
        ok: boolean;
        mock: boolean;
        source: {
            repoUrl: string;
            baseCommit: string;
            ref: string;
            sizeKb: number;
            site: boolean;
        };
    };
    /** POST /requests/quote. */
    quote(scope: string, body: Record<string, unknown>, baseUrl: string): {
        status: number;
        order: OrderRecord;
    };
    private record;
    /** POST /requests/{id}/submit, with or without the PAYMENT-SIGNATURE header. */
    submit(scope: string, id: string, paymentHeader: string | undefined, body: unknown): {
        status: number;
        body: unknown;
        headers: Record<string, string>;
    };
    /** Runs the canned admission: an order moves from admission_pending to admitted. */
    admit(order: OrderRecord): void;
    /**
     * The mock has no timers, so every read advances the work one step:
     * admission_pending -> admitted (job executing) -> job completed.
     */
    private advance;
    statusOf(order: OrderRecord): RequestStatus;
    /** GET /requests/{id}. */
    getRequest(scope: string, id: string): RequestStatusResponse;
    /** GET /jobs/{id}: public, like the live route. */
    getJob(id: string): {
        id: string;
        state: "executing" | "completed";
        template: string | null;
        objective: string;
        blockedReason: null;
        createdAt: string;
        updatedAt: string;
        paidBy: string;
        parentJobId: string | null;
        mock: boolean;
        project: {
            id: string;
            head: string | null;
            running: string | null;
            versions: never[];
        };
        delivery: null;
        nodes: {
            key: string;
            state: "executing" | "completed";
            attempt: number;
            verdict: string | null;
        }[];
    };
    /** GET /jobs/{id}/result. */
    getJobResult(id: string): {
        jobId: string;
        projectId: string;
        state: "executing" | "completed";
        complete: boolean;
        mock: boolean;
        source: never[];
        files: {
            name: string;
            path: string;
            mediaType: string;
            hash: string;
            bytes: number;
            submissionHash: string;
            url: string;
        }[];
        delivery: null;
    };
    orderView(order: OrderRecord): Order;
    statusView(order: OrderRecord): RequestStatusResponse;
    jobView(job: JobRecord): {
        id: string;
        state: "executing" | "completed";
        template: string | null;
        objective: string;
        blockedReason: null;
        createdAt: string;
        updatedAt: string;
        paidBy: string;
        parentJobId: string | null;
        mock: boolean;
        project: {
            id: string;
            head: string | null;
            running: string | null;
            versions: never[];
        };
        delivery: null;
        nodes: {
            key: string;
            state: "executing" | "completed";
            attempt: number;
            verdict: string | null;
        }[];
    };
}
export declare function createMockServer(options?: MockOptions): {
    server: Server;
    state: MockState;
};
/** Starts the mock and resolves once it is listening. Port 0 picks a free port. */
export declare function startMock(port?: number, host?: string, options?: MockOptions): Promise<{
    url: string;
    port: number;
    state: MockState;
    server: Server<typeof IncomingMessage, typeof ServerResponse>;
    close: () => Promise<void>;
}>;
export {};
