import { acp } from "./definition.js";
import { extractJsonObject } from "./json.js";
import type { AcpNodeDefinition, FlowEdge, FlowNodeContext } from "./types.js";

const DEFAULT_FIELD = "route";
const SIMPLE_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// All `acp` node fields except the ones the decision helper owns.
type DecisionAcpOptions = Omit<AcpNodeDefinition, "nodeType" | "prompt" | "parse">;

export type DecisionDefinition<TChoice extends string> = DecisionAcpOptions & {
  question: string | ((context: FlowNodeContext) => string | Promise<string>);
  choices: readonly TChoice[];
  field?: string;
};

// Build an `acp` node that asks the model to pick one of `choices` and reply
// with a JSON object whose chosen field is validated. Pair with `decisionEdge`
// (or any `switch` edge keyed on `$.<field>`) to route on the result.
export function decision<TChoice extends string>(
  definition: DecisionDefinition<TChoice>,
): AcpNodeDefinition {
  const { question, choices, field: fieldOverride, ...acpOptions } = definition;
  const field = normalizeField(fieldOverride);
  assertValidChoices(choices);
  const allowed = new Set<string>(choices);

  return acp({
    ...acpOptions,
    async prompt(context) {
      const text = typeof question === "function" ? await question(context) : question;
      return formatDecisionPrompt(text, choices, field);
    },
    parse(text) {
      const raw = extractJsonObject(text);
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Decision response must be a JSON object, got ${typeof raw}`);
      }
      const value = (raw as Record<string, unknown>)[field];
      if (typeof value !== "string" || !allowed.has(value)) {
        const allowedLabels = choices.map((choice) => JSON.stringify(choice)).join(", ");
        throw new Error(
          `Decision returned invalid ${field}=${JSON.stringify(value)}; expected one of ${allowedLabels}`,
        );
      }
      return raw;
    },
  });
}

// Build the matching `switch` edge for a `decision` node. Typing `cases` as
// `Record<TChoice, string>` makes a missing case a compile error.
export function decisionEdge<TChoice extends string>(args: {
  from: string;
  choices: readonly TChoice[];
  field?: string;
  cases: Record<TChoice, string>;
}): FlowEdge {
  const field = normalizeField(args.field);
  assertValidChoices(args.choices);
  for (const choice of args.choices) {
    if (!Object.hasOwn(args.cases, choice)) {
      throw new Error(`Decision edge is missing case for choice ${JSON.stringify(choice)}`);
    }
  }
  return {
    from: args.from,
    switch: {
      on: `$.${field}`,
      cases: args.cases as Record<string, string>,
    },
  };
}

function assertValidChoices(choices: readonly string[]): void {
  if (choices.length === 0) {
    throw new Error("Decision choices must include at least one value");
  }
  const seen = new Set<string>();
  for (const choice of choices) {
    if (typeof choice !== "string" || choice.length === 0) {
      throw new Error("Decision choices must be non-empty strings");
    }
    if (seen.has(choice)) {
      throw new Error(`Decision choices must be unique; duplicate ${JSON.stringify(choice)}`);
    }
    seen.add(choice);
  }
}

function normalizeField(fieldOverride: string | undefined): string {
  const field = fieldOverride ?? DEFAULT_FIELD;
  if (!SIMPLE_FIELD_PATTERN.test(field)) {
    throw new Error(
      `Decision field must be a simple JSON key matching ${SIMPLE_FIELD_PATTERN.source}`,
    );
  }
  return field;
}

function formatDecisionPrompt(question: string, choices: readonly string[], field: string): string {
  const allowed = choices.map((choice) => JSON.stringify(choice)).join(" | ");
  return [
    question,
    "",
    "Return exactly one JSON object with this shape:",
    "{",
    `  ${JSON.stringify(field)}: ${allowed},`,
    '  "reason": "short justification"',
    "}",
    "",
    "Do not include any other text outside the JSON object.",
  ].join("\n");
}
