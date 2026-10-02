// The mock's action catalogue. These are stand-ins with the same envelope as
// real IMD actions (an action name and an input object); they are not the
// real catalogue. Each one validates its input and has a canned verdict.

import { PRICE_PER_ACTION } from "./protocol.js";

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
export const REFUSE_MARKER = "[refuse]";
export const MAX_INPUT_BYTES = 16384;

function stringField(input: Record<string, unknown>, key: string, min: number, max: number, problems: Problem[]): void {
  const v = input[key];
  if (typeof v !== "string") problems.push({ path: `input.${key}`, message: "must be a string" });
  else if (v.length < min || v.length > max) {
    problems.push({ path: `input.${key}`, message: `must be ${min} to ${max} characters` });
  }
}

function noExtraFields(input: Record<string, unknown>, allowed: string[], problems: Problem[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) problems.push({ path: `input.${key}`, message: "unknown field" });
  }
}

export const ACTIONS: Record<string, ActionSpec> = {
  echo: {
    summary: "Mock action that completes immediately and echoes its message back.",
    completion: "sync",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: { message: { type: "string", minLength: 1, maxLength: 280 } },
    },
    limits: { maxMessageLength: 280 },
    validate(input) {
      const problems: Problem[] = [];
      stringField(input, "message", 1, 280, problems);
      noExtraFields(input, ["message"], problems);
      return problems;
    },
    outcome(input) {
      return { echo: input.message };
    },
  },
  implement: {
    summary: "Mock action shaped like a repository task: returns 202 and runs a job that completes after polling.",
    completion: "async",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repoUrl", "baseCommit", "objective"],
      properties: {
        repoUrl: { type: "string", pattern: "^https://github\\.com/[^/]+/[^/]+$" },
        baseCommit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        objective: { type: "string", minLength: 20, maxLength: 8000 },
      },
    },
    limits: { maxObjectiveLength: 8000 },
    validate(input) {
      const problems: Problem[] = [];
      if (typeof input.repoUrl !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(input.repoUrl)) {
        problems.push({ path: "input.repoUrl", message: "must be https://github.com/<owner>/<repo>" });
      }
      if (typeof input.baseCommit !== "string" || !/^[0-9a-f]{40}$/.test(input.baseCommit)) {
        problems.push({ path: "input.baseCommit", message: "must be a 40-character lowercase commit sha" });
      }
      stringField(input, "objective", 20, 8000, problems);
      noExtraFields(input, ["repoUrl", "baseCommit", "objective"], problems);
      return problems;
    },
    outcome(input) {
      return {
        summary: "Mock job finished. Nothing was built; this outcome is canned.",
        repoUrl: input.repoUrl,
        baseCommit: input.baseCommit,
      };
    },
  },
};

/** Validates the {action, input} envelope and the action's own input rules. */
export function validateRequest(action: unknown, input: unknown): Problem[] {
  if (typeof action !== "string" || !ACTIONS[action]) {
    return [{ path: "action", message: `must be one of: ${Object.keys(ACTIONS).join(", ")}` }];
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [{ path: "input", message: "must be an object" }];
  }
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) {
    return [{ path: "input", message: `must serialise to at most ${MAX_INPUT_BYTES} bytes` }];
  }
  return ACTIONS[action].validate(input as Record<string, unknown>);
}

/** The canned evaluator verdict for a valid request. */
export function cannedVerdict(input: Record<string, unknown>): Verdict {
  const refused = Object.values(input).some((v) => typeof v === "string" && v.includes(REFUSE_MARKER));
  return refused
    ? { verdict: "refuse", reasons: [`canned refusal: input contains ${REFUSE_MARKER}`] }
    : { verdict: "accept", reasons: [] };
}

export function actionsExtension(quoteLifetimeSeconds: number): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(ACTIONS).map(([name, spec]) => [
      name,
      {
        summary: spec.summary,
        price: PRICE_PER_ACTION,
        completion: spec.completion,
        inputSchema: spec.inputSchema,
        limits: { ...spec.limits, maxInputBytes: MAX_INPUT_BYTES, quoteLifetimeSeconds },
      },
    ]),
  );
}
