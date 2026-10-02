// Shapes and constants of the IMD paid-request flow, shared by the mock
// server, the reference client and the conformance suite. The shapes follow
// https://imd.fun/docs#paid and the live https://api.imd.fun/openapi.json.
import { createHash } from "node:crypto";
export const EXPERIMENTAL_NOTICE = "Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.";
export const CHAIN_ID = 1;
export const NETWORK = "eip155:1";
/** IMD token on Ethereum mainnet. */
export const IMD_TOKEN = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
export const IMD_DECIMALS = 18;
/** 0.5 IMD per action, and per run for a schedule. */
export const PRICE_PER_ACTION = "500000000000000000";
export const DEFAULT_QUOTE_TTL_SECONDS = 600;
/** accepts[0].maxTimeoutSeconds, as the live API reports it. */
export const MAX_TIMEOUT_SECONDS = 300;
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** x402 "exact" scheme Permit2 proxy: the spender of every permit. */
export const X402_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
/** A permit deadline must be at least this many seconds before quote.expiresAt. */
export const DEADLINE_MARGIN_SECONDS = 5;
/** `GET /requests/:id` statuses a client keeps polling through. */
export const PENDING_STATUSES = ["quoted", "payment_pending", "admission_pending"];
export const PERMIT2_DOMAIN = {
    name: "Permit2",
    chainId: CHAIN_ID,
    verifyingContract: PERMIT2_ADDRESS,
};
export const PERMIT2_TYPES = {
    PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
    ],
    TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
    ],
    Witness: [
        { name: "to", type: "address" },
        { name: "validAfter", type: "uint256" },
    ],
};
export const QUOTE_APPROVAL_DOMAIN = {
    name: "IdentityMD Paid Action",
    version: "1",
    chainId: CHAIN_ID,
};
export const QUOTE_APPROVAL_TYPES = {
    QuoteApproval: [
        { name: "resource", type: "string" },
        { name: "requesterScopeHash", type: "bytes32" },
        { name: "quoteId", type: "string" },
        { name: "quoteHash", type: "bytes32" },
        { name: "paymentHash", type: "bytes32" },
        { name: "action", type: "string" },
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "payTo", type: "address" },
        { name: "expiresAt", type: "uint256" },
    ],
};
export function permit2TypedData(auth) {
    return {
        domain: { ...PERMIT2_DOMAIN },
        types: PERMIT2_TYPES,
        primaryType: "PermitWitnessTransferFrom",
        message: {
            permitted: { token: auth.permitted.token, amount: auth.permitted.amount },
            spender: auth.spender,
            nonce: auth.nonce,
            deadline: auth.deadline,
            witness: { to: auth.witness.to, validAfter: auth.witness.validAfter },
        },
    };
}
export function quoteApprovalTypedData(approval) {
    return {
        domain: { ...QUOTE_APPROVAL_DOMAIN },
        types: QUOTE_APPROVAL_TYPES,
        primaryType: "QuoteApproval",
        message: { ...approval },
    };
}
/** The QuoteApproval a payer signs for a given challenge and payment. */
export function quoteApprovalFor(challenge, payment) {
    return {
        resource: challenge.resourceUrl,
        requesterScopeHash: `0x${challenge.requesterScopeHash}`,
        quoteId: challenge.quote.id,
        quoteHash: `0x${challenge.quote.quoteHash}`,
        paymentHash: paymentHash(payment),
        action: challenge.quote.action,
        asset: challenge.quote.payment.asset,
        amount: challenge.quote.payment.amount,
        payTo: challenge.quote.payment.payTo,
        expiresAt: String(challenge.quote.expiresAt),
    };
}
/** JSON with object keys sorted recursively and no whitespace. */
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const entries = Object.keys(value)
            .sort()
            .filter((k) => value[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}
export function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
/** sha256 of the key-sorted JSON payment object, as a 0x-prefixed bytes32. */
export function paymentHash(payment) {
    return `0x${sha256Hex(canonicalJson(payment))}`;
}
export function encodePaymentHeader(payment) {
    return Buffer.from(JSON.stringify(payment), "utf8").toString("base64");
}
/** A deterministic, well-formed UUID v4 derived from a label. */
export function uuidFrom(label) {
    const h = sha256Hex(label);
    const version = `4${h.slice(13, 16)}`;
    const variant = `${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}`;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${version}-${variant}-${h.slice(20, 32)}`;
}
