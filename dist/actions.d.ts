export interface Problem {
    path: string;
    message: string;
}
export interface Verdict {
    verdict: "accept" | "refuse";
    reasons: string[];
}
export interface ActionSpec {
    summary: string;
    /** "sync" completes inside the paid submit (200); "async" returns 202 and runs a job. */
    completion: "sync" | "async";
    inputSchema: Record<string, unknown>;
    limits: Record<string, number>;
    validate(input: Record<string, unknown>): Problem[];
    outcome(input: Record<string, unknown>): Record<string, unknown>;
}
/** Inputs containing this marker in any string field get a "refuse" verdict. */
export declare const REFUSE_MARKER = "[refuse]";
export declare const MAX_INPUT_BYTES = 16384;
export declare const ACTIONS: Record<string, ActionSpec>;
/** Validates the {action, input} envelope and the action's own input rules. */
export declare function validateRequest(action: unknown, input: unknown): Problem[];
/** The canned evaluator verdict for a valid request. */
export declare function cannedVerdict(input: Record<string, unknown>): Verdict;
export declare function actionsExtension(quoteLifetimeSeconds: number): Record<string, unknown>;
