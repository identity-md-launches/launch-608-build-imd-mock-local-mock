import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type OrderStatus, type PaymentChallenge, type PaymentRequirements, type Quote } from "./protocol.js";
export interface MockOptions {
    /** Refuse every distinct /requests/check body once, then answer normally. */
    flaky?: boolean;
    /** Clock in milliseconds. Default Date.now. */
    now?: () => number;
    quoteLifetimeSeconds?: number;
    payTo?: string;
    /** Public base URL used in resourceUrl. Default: http://<Host header>. */
    publicUrl?: string;
    /** Called with one line per request; default silent. */
    log?: (line: string) => void;
}
interface Job {
    id: string;
    requestId: string;
    action: string;
    status: "queued" | "running" | "completed";
    result?: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
}
interface Order {
    id: string;
    scope: string;
    requestKey: string;
    action: string;
    input: Record<string, unknown>;
    status: OrderStatus;
    challenge: PaymentChallenge;
    createdAt: number;
    updatedAt: number;
    payment?: {
        payer: string;
        nonce: string;
        paymentHash: string;
        transaction: string;
    };
    jobId?: string;
    outcome?: Record<string, unknown>;
    refusal?: {
        reasons: string[];
    };
}
export declare class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    readonly extra: Record<string, unknown>;
    constructor(status: number, code: string, message: string, extra?: Record<string, unknown>);
}
export declare class MockState {
    readonly options: MockOptions;
    readonly orders: Map<string, Order>;
    readonly jobs: Map<string, Job>;
    readonly requestKeys: Map<string, string>;
    readonly usedNonces: Set<string>;
    readonly flakySeen: Set<string>;
    readonly flaky: boolean;
    readonly quoteLifetimeSeconds: number;
    readonly payTo: string;
    readonly now: () => number;
    constructor(options?: MockOptions);
    nowSeconds(): number;
    accepts(): PaymentRequirements;
    capabilities(): {
        mock: boolean;
        notice: string;
        x402Version: number;
        chainId: number;
        network: string;
        asset: `0x${string}`;
        assetSymbol: string;
        assetDecimals: number;
        price: string;
        priceUnit: string;
        payTo: string;
        quoteLifetimeSeconds: number;
        deadlineMarginSeconds: number;
        permit2: `0x${string}`;
        spender: `0x${string}`;
        launchChains: {
            chainId: number;
            network: string;
            name: string;
        }[];
        actions: string[];
    };
    openapi(): {
        openapi: string;
        info: {
            title: string;
            version: string;
            description: string;
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
        };
        "x-imd-actions": Record<string, unknown>;
    };
    check(body: Record<string, unknown>): {
        verdict: string;
        reasons: string[];
    };
    importRepo(body: Record<string, unknown>): {
        repoUrl: string;
        baseCommit: string;
        mock: boolean;
    };
    quote(scope: string, body: Record<string, unknown>, baseUrl: string): {
        status: number;
        order: Order;
    };
    order(scope: string, id: string): Order;
    setStatus(order: Order, status: OrderStatus): void;
    submit(scope: string, id: string, paymentHeader: string | undefined, body: unknown): {
        status: number;
        body: unknown;
        headers: Record<string, string>;
    };
    /** Runs the canned admission verdict: completes sync actions, queues a job for async ones. */
    admit(order: Order): void;
    /**
     * Each read advances an async order one step, so polling is deterministic:
     * admission_pending -> running (job queued) -> job running -> completed.
     */
    advance(order: Order): void;
    getRequest(scope: string, id: string): {
        order: {
            refusal?: {
                reasons: string[];
            } | undefined;
            outcome?: Record<string, unknown> | undefined;
            jobId?: string | undefined;
            payment?: {
                payer: string;
                transaction: string;
                network: string;
            } | undefined;
            id: string;
            requestKey: string;
            action: string;
            status: OrderStatus;
            quote: Quote;
            resourceUrl: string;
            createdAt: number;
            updatedAt: number;
        };
    };
    getJob(scope: string, id: string): {
        job: {
            id: string;
            requestId: string;
            action: string;
            status: "queued" | "running" | "completed";
            result?: Record<string, unknown>;
            createdAt: number;
            updatedAt: number;
        };
    };
    orderView(order: Order): {
        refusal?: {
            reasons: string[];
        } | undefined;
        outcome?: Record<string, unknown> | undefined;
        jobId?: string | undefined;
        payment?: {
            payer: string;
            transaction: string;
            network: string;
        } | undefined;
        id: string;
        requestKey: string;
        action: string;
        status: OrderStatus;
        quote: Quote;
        resourceUrl: string;
        createdAt: number;
        updatedAt: number;
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
