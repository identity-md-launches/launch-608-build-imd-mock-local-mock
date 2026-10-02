import { type AdmissionResult } from "./protocol.js";
export interface Problem {
    path: string;
    message: string;
}
/** A blocker or suggestion from POST /requests/check. */
export interface Note {
    code: string;
    detail: string;
    [key: string]: unknown;
}
/** Stable ids the mock derives from an order, for the admission result. */
export interface AdmissionIds {
    jobId: string;
    workflowId: string;
    oracleRequestId: string;
    scheduleId: string;
}
export interface ActionSpec {
    /** The action name, e.g. "job.open". */
    action: string;
    /** quote.policyVersion for this action. */
    version: string;
    summary: string;
    limits: Record<string, number>;
    /** Set on the actions charged per unit instead of once. */
    pricedPer?: "run";
    validate(input: Record<string, unknown>): Problem[];
    /** Defaults the quote pins on top of the client's input. */
    prepare(input: Record<string, unknown>): Record<string, unknown>;
    /** Units bought: 1, or `runs` for a schedule. */
    units(input: Record<string, unknown>): number;
    /** What POST /requests/check adds beyond {action, blockers, suggestions}. */
    preview(input: Record<string, unknown>): Record<string, unknown>;
    /** Admit inside the paid submit (200 outcome) instead of on the next poll (202). */
    admitsOnSubmit: boolean;
    result(ids: AdmissionIds, input: Record<string, unknown>): AdmissionResult;
}
/** Inputs carrying this marker anywhere are blocked by the canned evaluator. */
export declare const REFUSE_MARKER = "[refuse]";
/** Inputs carrying this marker are admitted, then refused as a stale catalogue. */
export declare const STALE_MARKER = "[stale]";
/** 16 KiB for the whole quote body, as the live API documents. */
export declare const MAX_INPUT_BYTES = 16384;
export declare const ACTIONS: Record<string, ActionSpec>;
export declare const ACTION_NAMES: string[];
/** Validates the {action, input} envelope and the action's own input rules. */
export declare function validateRequest(action: unknown, input: unknown): Problem[];
/** True when any string anywhere in the input carries the marker. */
export declare function hasMarker(value: unknown, marker: string): boolean;
/** The canned evaluator blockers: a [refuse] marker anywhere blocks the request. */
export declare function cannedBlockers(input: Record<string, unknown>): Note[];
/** The canned suggestions: advisory only, never a reason to refuse. */
export declare function cannedSuggestions(input: Record<string, unknown>): Note[];
/** The `actions` array of GET /requests/capabilities and `x-imd-actions`. */
export declare function actionsExtension(quoteTtlSeconds: number, payTo: string, withLimits: boolean): Array<Record<string, unknown>>;
/** The per-action `limits` map of GET /requests/capabilities. */
export declare function limitsExtension(): Record<string, Record<string, number>>;
/** The `pricedPer` map of GET /requests/capabilities. */
export declare function pricedPerExtension(): Record<string, string>;
