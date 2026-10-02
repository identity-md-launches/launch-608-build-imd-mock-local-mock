// The action catalogue: the seven paid actions the live API enables, with
// their documented policy versions, limits, prices and admission results
// (https://imd.fun/docs#paid). Input validation here is a useful subset of
// the real rules — enough to catch a malformed integration, not a reproduction
// of the evaluator — and, like the real API, unknown input fields are kept
// rather than refused.
import { IMD_DECIMALS, IMD_TOKEN, NETWORK, PRICE_PER_ACTION } from "./protocol.js";
/** Inputs carrying this marker anywhere are blocked by the canned evaluator. */
export const REFUSE_MARKER = "[refuse]";
/** Inputs carrying this marker are admitted, then refused as a stale catalogue. */
export const STALE_MARKER = "[stale]";
/** 16 KiB for the whole quote body, as the live API documents. */
export const MAX_INPUT_BYTES = 16384;
const TEMPLATES = ["single", "impl_tests", "impl_tests_review", "multi_contract", "fuzz", "research", "audit"];
const SHAPES = ["chain", "fan_out_join", "dag"];
const LAUNCH_KINDS = ["univ4_hook", "evm_project", "custom_token"];
const ANSWER_TYPES = ["bool", "address", "bytes32", "uint256", "address[]", "bytes32[]"];
const ISO_DURATION = /^P(?!$)(\d+[YMWD])*(T(?!$)(\d+[HMS])*)?$/;
/** Collects problems for one input object, one field at a time. */
class Fields {
    input;
    problems;
    prefix;
    constructor(input, problems, prefix = "input") {
        this.input = input;
        this.problems = problems;
        this.prefix = prefix;
    }
    has(key) {
        return Object.hasOwn(this.input, key) && this.input[key] !== undefined;
    }
    bad(key, message) {
        this.problems.push({ path: `${this.prefix}.${key}`, message });
    }
    /** True when the field is present and worth checking further. */
    present(key, required) {
        if (this.has(key))
            return true;
        if (required)
            this.bad(key, "is required");
        return false;
    }
    str(key, { required = false, min = 1, max = 8000 } = {}) {
        if (!this.present(key, required))
            return;
        const v = this.input[key];
        if (typeof v !== "string")
            this.bad(key, "must be a string");
        else if (v.length < min || v.length > max)
            this.bad(key, `must be ${min} to ${max} characters`);
    }
    int(key, { required = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
        if (!this.present(key, required))
            return;
        const v = this.input[key];
        if (!Number.isInteger(v))
            this.bad(key, "must be an integer");
        else if (v < min || v > max)
            this.bad(key, `must be ${min} to ${max}`);
    }
    bool(key, { required = false } = {}) {
        if (!this.present(key, required))
            return;
        if (typeof this.input[key] !== "boolean")
            this.bad(key, "must be a boolean");
    }
    oneOf(key, values, { required = false, alsoTrue = false } = {}) {
        if (!this.present(key, required))
            return;
        const v = this.input[key];
        if (alsoTrue && v === true)
            return;
        if (typeof v !== "string" || !values.includes(v)) {
            this.bad(key, `must be ${alsoTrue ? "true or " : ""}one of: ${values.join(", ")}`);
        }
    }
    pattern(key, re, what, { required = false } = {}) {
        if (!this.present(key, required))
            return;
        const v = this.input[key];
        if (typeof v !== "string" || !re.test(v))
            this.bad(key, `must be ${what}`);
    }
    array(key, { required = false, min = 1, max = 32 } = {}) {
        if (!this.present(key, required))
            return;
        const v = this.input[key];
        if (!Array.isArray(v))
            this.bad(key, "must be an array");
        else if (v.length < min || v.length > max)
            this.bad(key, `must have ${min} to ${max} entries`);
    }
    object(key, { required = false } = {}) {
        if (!this.present(key, required))
            return undefined;
        const v = this.input[key];
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
            this.bad(key, "must be an object");
            return undefined;
        }
        return v;
    }
    /** A field the live API refuses on this action. */
    refuse(key, why) {
        if (this.has(key))
            this.bad(key, why);
    }
    /** Two fields that must be given together or not at all. */
    together(a, b) {
        if (this.has(a) !== this.has(b))
            this.bad(this.has(a) ? b : a, `${a} and ${b} must be given together`);
    }
    /** Fields that may not be combined. */
    exclusive(key, others) {
        if (!this.has(key))
            return;
        const clash = others.filter((o) => this.has(o));
        if (clash.length > 0)
            this.bad(key, `must not be used with ${clash.join(" or ")}`);
    }
}
/** The job body shared by job.open, job.continue, launch.open and nested drafts. */
function jobBody(f, { launch = false, nested = false } = {}) {
    f.str("objective", { required: true, min: 1, max: 8000 });
    f.str("skill", { max: 64 });
    f.oneOf("template", TEMPLATES);
    f.oneOf("shape", SHAPES);
    f.array("steps", { min: 1, max: 6 });
    f.array("references", { max: 8 });
    f.exclusive("skill", ["steps", "template"]);
    if (Array.isArray(f.input.steps) && typeof f.input.shape !== "string") {
        f.problems.push({ path: `${f.prefix}.shape`, message: "is required with steps" });
    }
    f.str("repoUrl", { max: 512 });
    f.pattern("baseCommit", /^[0-9a-f]{40}$/, "40 lowercase hex characters");
    f.together("repoUrl", "baseCommit");
    f.array("contracts", { min: 0, max: 4 });
    f.array("paths", { max: 16 });
    f.array("inputs", { max: 32 });
    f.array("outputs", { max: 32 });
    f.bool("github");
    f.int("minCitations", { min: 0, max: 20 });
    f.int("panelSize", { min: 1, max: 9 });
    f.int("panelQuorum", { min: 1, max: 9 });
    f.refuse("projectId", "is not accepted on a paid job; pass repoUrl and baseCommit instead");
    f.refuse("deploymentLaunchId", "is not accepted on a paid job");
    if (launch) {
        f.oneOf("onchain", LAUNCH_KINDS, { required: true, alsoTrue: true });
        f.int("chainId", { min: 1 });
        f.oneOf("pairWith", ["eth", "imd"]);
    }
    else {
        f.refuse("onchain", nested ? "belongs on the launch step, not here" : "is only accepted on launch.open");
    }
}
/** What the evaluator would call this job: the live check reports the same field. */
function jobKind(input) {
    if (input.skill === "research-report" || input.template === "research")
        return "report";
    if (input.onchain !== undefined || Array.isArray(input.contracts) && input.contracts.length > 0)
        return "contracts";
    if (typeof input.skill === "string" && /website|frontend|site/.test(input.skill))
        return "site";
    return "other";
}
function jobPlan(input) {
    const steps = Array.isArray(input.steps) ? input.steps : null;
    if (steps) {
        return steps.map((s, i) => ({ title: `Step ${i + 1}: ${s.skill}`, short: String(s.skill), skill: s.skill, stage: i }));
    }
    const skill = typeof input.skill === "string" ? input.skill : "build-and-test";
    return [{ title: `Run ${skill} against the objective`, short: skill, skill, stage: 0 }];
}
function jobFacts(input) {
    return [
        { id: "objective", label: "What to build", state: "stated", required: true },
        {
            id: "source",
            label: "Starting source",
            state: input.repoUrl === undefined ? "missing" : "stated",
            required: false,
            ...(input.repoUrl === undefined ? { assumed: "Assumed: an empty workspace." } : {}),
        },
        {
            id: "delivery",
            label: "Where the result goes",
            state: input.github === undefined && input.ipfs === undefined ? "unknown" : "stated",
            required: false,
        },
    ];
}
function jobPreview(input) {
    return { kind: jobKind(input), plan: jobPlan(input), facts: jobFacts(input), judged: true };
}
/** Defaults the quote pins, matching the way the live quote normalises a job body. */
function prepareJob(input) {
    return { contracts: [], github: false, ...input };
}
const jobLinks = (jobId) => ({ statusUrl: `/jobs/${jobId}`, resultUrl: `/jobs/${jobId}/result` });
const SPECS = [
    {
        action: "job.open",
        version: "job-1",
        summary: "Opens a job. Input is a job body without onchain.",
        limits: {},
        validate(input) {
            const problems = [];
            jobBody(new Fields(input, problems), {});
            new Fields(input, problems).refuse("parentJobId", "is only accepted on job.continue");
            return problems;
        },
        prepare: prepareJob,
        units: () => 1,
        preview: jobPreview,
        admitsOnSubmit: false,
        result: ({ jobId }) => ({ kind: "job", jobId, launch: false, ...jobLinks(jobId) }),
    },
    {
        action: "job.continue",
        version: "job-1",
        summary: "The next version of a project your wallet paid for. Input is a job body with parentJobId.",
        limits: {},
        validate(input) {
            const problems = [];
            const f = new Fields(input, problems);
            jobBody(f, {});
            f.str("parentJobId", { required: true, max: 64 });
            return problems;
        },
        prepare: prepareJob,
        units: () => 1,
        preview: (input) => ({
            ...jobPreview(input),
            project: {
                summary: `Mock project continuing ${input.parentJobId}.`,
                next: [{ skill: "refine-project", why: "the canned next step the mock always suggests" }],
            },
        }),
        admitsOnSubmit: false,
        result: ({ jobId }, input) => ({ kind: "job", jobId, continues: input.parentJobId, ...jobLinks(jobId) }),
    },
    {
        action: "launch.open",
        version: "launch-1",
        summary: "A job that ends in a contract launch. Input is a job body with onchain.",
        limits: {},
        validate(input) {
            const problems = [];
            const f = new Fields(input, problems);
            jobBody(f, { launch: true });
            f.refuse("parentJobId", "is only accepted on job.continue");
            if (input.onchain === "custom_token") {
                const economics = f.object("economics", { required: true });
                if (economics) {
                    const e = new Fields(economics, problems, "input.economics");
                    e.int("poolBps", { required: true, min: 1, max: 9000 });
                    e.pattern("initialMarketCapWei", /^(0|[1-9][0-9]*)$/, "a decimal string", { required: true });
                    if (economics.poolBps !== 9000)
                        e.pattern("remainderTo", /^0x[0-9a-fA-F]{40}$/, "an address", { required: true });
                }
            }
            return problems;
        },
        prepare: (input) => ({ chainId: 11155111, ...prepareJob(input) }),
        units: () => 1,
        preview: (input) => ({ ...jobPreview(input), kind: "contracts" }),
        admitsOnSubmit: false,
        result: ({ jobId }) => ({ kind: "job", jobId, launch: true, ...jobLinks(jobId) }),
    },
    {
        action: "workflow.open",
        version: "workflow-1",
        summary: "Contracts, review, deployment, then a site built against the live addresses.",
        limits: {},
        validate(input) {
            const problems = [];
            const f = new Fields(input, problems);
            f.str("request", { required: true, min: 1, max: 16000 });
            f.str("context", { min: 0, max: 16000 });
            const draft = f.object("draft", { required: true });
            if (draft) {
                const d = new Fields(draft, problems, "input.draft");
                jobBody(d, { launch: true, nested: true });
                if (draft.shape !== "chain" && draft.shape !== "dag") {
                    problems.push({ path: "input.draft.shape", message: "must be chain or dag" });
                }
            }
            const permissions = f.object("permissions", { required: true });
            if (permissions) {
                const p = new Fields(permissions, problems, "input.permissions");
                p.bool("github");
                const onchain = p.object("onchain", { required: true });
                if (onchain) {
                    const o = new Fields(onchain, problems, "input.permissions.onchain");
                    o.oneOf("kind", LAUNCH_KINDS, { required: true });
                    o.int("chainId", { required: true, min: 1 });
                }
            }
            return problems;
        },
        prepare: (input) => ({ context: "", ...input }),
        units: () => 1,
        preview: (input) => ({ kind: "workflow", plan: jobPlan((input.draft ?? {})), facts: [], judged: true }),
        admitsOnSubmit: false,
        result: ({ workflowId, jobId }) => ({
            kind: "workflow",
            workflowId,
            jobId,
            statusUrl: `/workflows/${workflowId}`,
            jobUrl: `/jobs/${jobId}`,
        }),
    },
    {
        action: "oracle.request",
        version: "oracle-1",
        summary: "An oracle question and its panel. Input is an oracle body.",
        limits: { minPanelSize: 5, maxPanelSize: 100 },
        validate(input) {
            const problems = [];
            const f = new Fields(input, problems);
            if (input.v !== 1)
                problems.push({ path: "input.v", message: "must be 1" });
            f.str("question", { required: true, min: 1, max: 2000 });
            f.int("chainId", { required: true, min: 1 });
            f.oneOf("answerType", ANSWER_TYPES, { required: true });
            f.int("panelSize", { required: true, min: 5, max: 100 });
            f.int("quorum", { required: true, min: 2, max: typeof input.panelSize === "number" ? input.panelSize : 100 });
            f.int("validForSeconds", { required: true, min: 60, max: 2592000 });
            f.oneOf("evidence", ["chain", "panel"]);
            f.int("toleranceBps", { min: 0, max: 10000 });
            f.int("head", { min: 1, max: 32 });
            const window = f.object("window", { required: true });
            if (window) {
                const w = new Fields(window, problems, "input.window");
                if (Object.hasOwn(window, "hours"))
                    w.int("hours", { min: 1, max: 720 });
                else {
                    w.int("fromBlock", { required: true });
                    w.int("toBlock", { required: true });
                }
            }
            f.refuse("submissionKey", "is not accepted on a paid oracle request; the order is the key");
            return problems;
        },
        prepare: (input) => ({ evidence: "chain", ...input }),
        units: () => 1,
        preview: (input) => ({ kind: "oracle", request: { evidence: "chain", ...input }, judged: true, plan: [], facts: [] }),
        admitsOnSubmit: false,
        result: ({ oracleRequestId, jobId }) => ({
            kind: "oracle",
            requestId: oracleRequestId,
            jobId,
            statusUrl: `/oracle/requests/${oracleRequestId}`,
            attestationUrl: `/oracle/requests/${oracleRequestId}/attestation`,
        }),
    },
    {
        action: "schedule.create",
        version: "schedule-1",
        summary: "A question or a job opened on a cadence, as many times as you buy.",
        limits: { minRuns: 1, maxRuns: 1000000, minOracleIntervalMinutes: 10, minJobIntervalMinutes: 30 },
        pricedPer: "run",
        validate(input) {
            const problems = [];
            const f = new Fields(input, problems);
            f.oneOf("action", ["oracle.request", "job.open"], { required: true });
            f.int("runs", { required: true, min: 1, max: 1000000 });
            f.str("label", { min: 1, max: 120 });
            f.bool("continue");
            const cadence = f.object("cadence", { required: true });
            if (cadence) {
                const c = new Fields(cadence, problems, "input.cadence");
                if (Object.hasOwn(cadence, "cron")) {
                    c.pattern("cron", /^(\S+\s+){4}\S+$/, "five cron fields from minute to day of week");
                    c.str("tz", { max: 64 });
                }
                else {
                    c.pattern("every", ISO_DURATION, "an ISO 8601 duration such as PT6H, P1D or P2W", { required: true });
                }
            }
            const inner = f.object("input", { required: true });
            if (inner && typeof input.action === "string") {
                const spec = ACTIONS[input.action];
                if (spec) {
                    for (const p of spec.validate(inner))
                        problems.push({ path: p.path.replace(/^input\./, "input.input."), message: p.message });
                }
            }
            f.refuse("expiresAt", "is not accepted; a paid schedule does not expire");
            f.refuse("submissionKey", "is not accepted; the order is the key");
            return problems;
        },
        prepare: (input) => input,
        units: (input) => (typeof input.runs === "number" ? input.runs : 1),
        preview(input) {
            const runs = this.units(input);
            return {
                kind: "schedule",
                plan: [],
                facts: [],
                judged: true,
                unitAmount: PRICE_PER_ACTION,
                runs,
                amount: (BigInt(PRICE_PER_ACTION) * BigInt(runs)).toString(10),
                terms: { purchase: "action-admission", resultGuaranteed: false },
            };
        },
        admitsOnSubmit: true,
        result: ({ scheduleId }) => ({ kind: "schedule", scheduleId, statusUrl: `/schedules/${scheduleId}` }),
    },
    {
        action: "schedule.topup",
        version: "topup-1",
        summary: "More runs on any schedule, from any wallet.",
        limits: { minRuns: 1, maxRuns: 1000000, minOracleIntervalMinutes: 10, minJobIntervalMinutes: 30 },
        pricedPer: "run",
        validate(input) {
            const problems = [];
            const f = new Fields(input, problems);
            f.str("scheduleId", { required: true, max: 64 });
            f.int("runs", { required: true, min: 1, max: 1000000 });
            return problems;
        },
        prepare: (input) => input,
        units: (input) => (typeof input.runs === "number" ? input.runs : 1),
        preview(input) {
            const runs = this.units(input);
            return {
                kind: "schedule",
                plan: [],
                facts: [],
                judged: true,
                unitAmount: PRICE_PER_ACTION,
                runs,
                amount: (BigInt(PRICE_PER_ACTION) * BigInt(runs)).toString(10),
                terms: { purchase: "action-admission", resultGuaranteed: false },
            };
        },
        admitsOnSubmit: true,
        result: (_ids, input) => ({
            kind: "schedule",
            scheduleId: input.scheduleId,
            runsAdded: input.runs,
            statusUrl: `/schedules/${input.scheduleId}`,
        }),
    },
];
export const ACTIONS = Object.fromEntries(SPECS.map((s) => [s.action, s]));
export const ACTION_NAMES = SPECS.map((s) => s.action);
/** Validates the {action, input} envelope and the action's own input rules. */
export function validateRequest(action, input) {
    if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) {
        return [{ path: "action", message: `must be one of: ${ACTION_NAMES.join(", ")}` }];
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return [{ path: "input", message: "must be an object" }];
    }
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
        return [{ path: "input", message: `must serialise to at most ${MAX_INPUT_BYTES} bytes` }];
    }
    return ACTIONS[action].validate(input);
}
/** True when any string anywhere in the input carries the marker. */
export function hasMarker(value, marker) {
    if (typeof value === "string")
        return value.includes(marker);
    if (Array.isArray(value))
        return value.some((v) => hasMarker(v, marker));
    if (value !== null && typeof value === "object")
        return Object.values(value).some((v) => hasMarker(v, marker));
    return false;
}
/** The canned evaluator blockers: a [refuse] marker anywhere blocks the request. */
export function cannedBlockers(input) {
    return hasMarker(input, REFUSE_MARKER)
        ? [{ code: "canned_refusal", detail: `the mock blocks any input containing ${REFUSE_MARKER}` }]
        : [];
}
/** The canned suggestions: advisory only, never a reason to refuse. */
export function cannedSuggestions(input) {
    const notes = [];
    if (typeof input.objective === "string" && input.objective.length < 80) {
        notes.push({ code: "vague", detail: "Parts of this are open to interpretation. The builders will decide them; say what matters to you." });
    }
    if (hasMarker(input, STALE_MARKER)) {
        notes.push({ code: "mock_stale", detail: `the mock admits any input containing ${STALE_MARKER} and then refuses it as a stale catalogue` });
    }
    return notes;
}
/** The `actions` array of GET /requests/capabilities and `x-imd-actions`. */
export function actionsExtension(quoteTtlSeconds, payTo, withLimits) {
    return SPECS.map((spec) => ({
        action: spec.action,
        version: spec.version,
        payment: { network: NETWORK, asset: IMD_TOKEN, amount: PRICE_PER_ACTION, payTo, decimals: IMD_DECIMALS },
        quoteTtlSeconds,
        ...(withLimits ? { limits: spec.limits } : {}),
        ...(spec.pricedPer
            ? { pricedPer: spec.pricedPer, note: "payment.amount is the price of one; a quote charges it once per unit bought" }
            : {}),
    }));
}
/** The per-action `limits` map of GET /requests/capabilities. */
export function limitsExtension() {
    return Object.fromEntries(SPECS.filter((s) => Object.keys(s.limits).length > 0).map((s) => [s.action, s.limits]));
}
/** The `pricedPer` map of GET /requests/capabilities. */
export function pricedPerExtension() {
    return Object.fromEntries(SPECS.filter((s) => s.pricedPer).map((s) => [s.action, s.pricedPer]));
}
