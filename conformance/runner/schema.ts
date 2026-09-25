import type { ContentBlock } from "@agentclientprotocol/sdk";
import { z } from "zod";

const nonempty = z.string().min(1);
const identifier = nonempty.refine((value) => value.trim().length > 0, "Expected a nonblank ID");
const duration = z.number().nonnegative();
const expectation = z.strictObject({
  codes: z.array(z.number().int()).optional(),
  message_any: z.array(z.string()).optional(),
});

// Negative protocol tests must reach the adapter with their original payloads.
const session = z.unknown().nonoptional();
const prompt = z.array(z.custom<ContentBlock>());
const step = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("new_session"),
    cwd: z.unknown().optional(),
    save_as: nonempty.optional(),
    expect_error: expectation.optional(),
  }),
  z.strictObject({
    action: z.literal("prompt"),
    session,
    prompt,
    save_as: nonempty.optional(),
    expect_error: expectation.optional(),
    suppress_console_error: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("prompt_background"),
    session,
    prompt,
    save_as: nonempty,
  }),
  z.strictObject({
    action: z.literal("await_background"),
    from: nonempty,
    save_as: nonempty.optional(),
    expect_error: expectation.optional(),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    session,
    expect_error: expectation.optional(),
  }),
  z.strictObject({ action: z.literal("sleep"), ms: duration }),
]);

const check = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("initialize_protocol_version_number") }),
  z.strictObject({ type: z.literal("saved_non_empty_string"), key: nonempty }),
  z.strictObject({ type: z.literal("saved_error_present"), key: nonempty }),
  z.strictObject({
    type: z.literal("saved_stop_reason_in"),
    key: nonempty,
    values: z.array(nonempty).nonempty(),
  }),
  z.strictObject({
    type: z.literal("updates_count_at_least"),
    min: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("updates_all_session"), session: nonempty }),
  z.strictObject({ type: z.literal("updates_text_includes"), text: nonempty }),
  z.strictObject({
    type: z.literal("updates_session_update_includes"),
    values: z.array(nonempty).nonempty(),
  }),
  z
    .strictObject({
      type: z.literal("filesystem_operation"),
      method: z.enum(["read_text_file", "write_text_file"]),
      session: nonempty,
      path: nonempty,
      content: z.string().optional(),
      outcome: z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("success"), content_includes: nonempty.optional() }),
        z.strictObject({ type: z.literal("error"), code: z.number().int() }),
      ]),
    })
    .refine(
      (value) => (value.method === "write_text_file") === (value.content !== undefined),
      "content is required only for write_text_file",
    )
    .refine(
      (value) =>
        value.method === "read_text_file" ||
        value.outcome.type === "error" ||
        value.outcome.content_includes === undefined,
      "content_includes is only supported for successful reads",
    ),
]);

const caseDefinition = z.strictObject({
  id: identifier,
  title: z.string().optional(),
  profile: z.string().optional(),
  description: z.string().optional(),
  permission_mode: z.enum(["approve-all", "deny-all"]).optional(),
  steps: z.array(step).optional(),
  checks: z.array(check).optional(),
  timeouts: z
    .strictObject({
      request_timeout_ms: duration.optional(),
      update_timeout_ms: duration.optional(),
      settle_timeout_ms: duration.optional(),
    })
    .optional(),
});

const profileDefinition = z.strictObject({
  id: identifier,
  version: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  required_cases: z.array(identifier).nonempty(),
  optional_cases: z.array(identifier).optional(),
});

export type CaseDefinition = z.infer<typeof caseDefinition>;
export type CaseStep = z.infer<typeof step>;
export type ErrorExpectation = z.infer<typeof expectation>;
export type ProfileDefinition = z.infer<typeof profileDefinition>;

function valueAtPath(value: unknown, keys: PropertyKey[]): unknown {
  for (const key of keys) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function parseDefinition<T>(schema: z.ZodType<T>, value: unknown, filePath: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const details = parsed.error.issues.map((issue) => {
    const location = issue.path.map(String).join(".") || "root";
    const discriminator = issue.path.at(-1);
    const supplied = valueAtPath(value, issue.path);
    const actual =
      (discriminator === "action" || discriminator === "type") && typeof supplied === "string"
        ? ` (${JSON.stringify(supplied)})`
        : "";
    return `${location}: ${issue.message}${actual}`;
  });
  throw new Error(`Invalid conformance file ${filePath}: ${details.join("; ")}`);
}

export function parseCaseDefinition(value: unknown, filePath: string): CaseDefinition {
  return parseDefinition(caseDefinition, value, filePath);
}

export function parseProfileDefinition(value: unknown, filePath: string): ProfileDefinition {
  const profile = parseDefinition(profileDefinition, value, filePath);
  const seen = new Set<string>();
  for (const id of profile.required_cases) {
    if (seen.has(id)) {
      throw new Error(
        `Invalid conformance file ${filePath}: required_cases: duplicate ID ${JSON.stringify(id)}`,
      );
    }
    seen.add(id);
  }
  return profile;
}
