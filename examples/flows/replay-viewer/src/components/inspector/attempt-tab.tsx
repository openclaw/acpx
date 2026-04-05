import { formatDate, formatDuration, formatJson } from "../../lib/view-model.js";
import type { SelectedAttemptView } from "../../lib/view-model.js";
import { CodeBlock, DisclosureSection, Section } from "./common.js";

export function AttemptTab({ selectedAttempt }: { selectedAttempt: SelectedAttemptView }) {
  const { step } = selectedAttempt;

  return (
    <div className="inspector__section-stack">
      <Section
        title="Output"
        subtitle={`${formatDate(step.startedAt)} · ${formatDuration(Date.parse(step.finishedAt) - Date.parse(step.startedAt))}`}
      >
        <CodeBlock>{formatJson(step.output)}</CodeBlock>
      </Section>

      {step.promptText ? (
        <DisclosureSection title="Prompt text">
          <CodeBlock>{step.promptText}</CodeBlock>
        </DisclosureSection>
      ) : null}

      {step.rawText ? (
        <DisclosureSection title="Raw response">
          <CodeBlock>{step.rawText}</CodeBlock>
        </DisclosureSection>
      ) : null}

      {step.trace?.action ? (
        <DisclosureSection title="Action receipt">
          <CodeBlock>{formatJson(step.trace.action)}</CodeBlock>
        </DisclosureSection>
      ) : null}

      {step.error ? (
        <Section title="Error">
          <CodeBlock>{step.error}</CodeBlock>
        </Section>
      ) : null}
    </div>
  );
}
