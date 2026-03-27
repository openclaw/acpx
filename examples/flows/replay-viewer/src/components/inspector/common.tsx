import type { ReactNode } from "react";

export function Section({
  title,
  subtitle,
  fill = false,
  children,
}: {
  title: string;
  subtitle?: string;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`panel-section${fill ? " panel-section--fill" : ""}`}>
      <div className="panel-section__header">
        <h3>{title}</h3>
        {subtitle ? <div className="panel-section__subtitle">{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function DisclosureSection({
  title,
  children,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <details className={`panel-disclosure${compact ? " panel-disclosure--compact" : ""}`}>
      <summary>{title}</summary>
      <div className="panel-disclosure__body">{children}</div>
    </details>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return <pre className="code-block">{children}</pre>;
}
