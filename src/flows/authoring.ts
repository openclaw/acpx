import type { FlowDefinition } from "./types.js";

const FLOW_DEFINITION_BRAND = Symbol.for("acpx.flow.definition");

export function markDefinedFlow<TFlow extends FlowDefinition>(definition: TFlow): TFlow {
  if (isDefinedFlow(definition)) {
    return definition;
  }

  Object.defineProperty(definition, FLOW_DEFINITION_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return definition;
}

export function isDefinedFlow(value: unknown): value is FlowDefinition {
  return (
    value != null &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[FLOW_DEFINITION_BRAND] === true
  );
}
