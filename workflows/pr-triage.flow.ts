import { acp, compute, defineFlow, extractJsonObject } from "../src/flows.js";

type PullRequestContext = {
  repo: string;
  promptContext: string;
};

export default defineFlow({
  name: "pr-triage",
  startAt: "load_pr",
  nodes: {
    load_pr: compute({
      run: async ({ input, services }) => {
        const github = services.github as {
          loadPullRequestContext(options: {
            repo: string;
            prNumber: number;
          }): Promise<PullRequestContext>;
        };
        const flowInput = input as {
          repo: string;
          prNumber: number;
        };
        return await github.loadPullRequestContext({
          repo: flowInput.repo,
          prNumber: flowInput.prNumber,
        });
      },
    }),

    solution_fit: acp({
      profile: "codex",
      async prompt({ outputs }) {
        const context = outputs.load_pr as PullRequestContext;
        return [
          "You are doing maintainability-first PR triage.",
          "Question: is this the right solution for the underlying issue, or is it only a localized fix that does not address the real problem?",
          "Use only the PR context below.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "verdict": "right_solution" | "localized_fix" | "wrong_problem" | "unclear",',
          '  "confidence": 0.0,',
          '  "reason": "short explanation",',
          '  "evidence": ["short bullet", "short bullet"]',
          "}",
          "",
          context.promptContext,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    issue_clarity: acp({
      profile: "codex",
      async prompt() {
        return [
          "Use the PR context already in this session.",
          "Judge whether the underlying issue is clearly framed enough for safe autonomous continuation.",
          "If there is no linked issue, decide whether the PR body still makes the underlying problem clear.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "verdict": "clear" | "ambiguous" | "conflicting",',
          '  "confidence": 0.0,',
          '  "reason": "short explanation"',
          "}",
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    scope_assessment: acp({
      profile: "codex",
      async prompt() {
        return [
          "Use the PR context and earlier reasoning already in this session.",
          "Judge whether the scope is appropriately shaped for the codebase.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "scope": "appropriately_local" | "too_local" | "cross_cutting_needed",',
          '  "refactor_needed": "none" | "superficial" | "fundamental",',
          '  "human_judgment_needed": true | false,',
          '  "reason": "short explanation"',
          "}",
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    route: compute({
      run: ({ outputs }) => {
        const reasons: string[] = [];
        const solutionFit = outputs.solution_fit as {
          verdict?: string;
        };
        const issueClarity = outputs.issue_clarity as {
          verdict?: string;
        };
        const scopeAssessment = outputs.scope_assessment as {
          scope?: string;
          refactor_needed?: string;
          human_judgment_needed?: boolean;
        };

        if (solutionFit.verdict !== "right_solution") {
          reasons.push(`solution_fit=${solutionFit.verdict ?? "unknown"}`);
        }
        if (issueClarity.verdict !== "clear") {
          reasons.push(`issue_clarity=${issueClarity.verdict ?? "unknown"}`);
        }
        if (scopeAssessment.scope !== "appropriately_local") {
          reasons.push(`scope=${scopeAssessment.scope ?? "unknown"}`);
        }
        if (scopeAssessment.refactor_needed === "fundamental") {
          reasons.push("refactor_needed=fundamental");
        }
        if (scopeAssessment.human_judgment_needed) {
          reasons.push("human_judgment_needed=true");
        }

        return {
          next: reasons.length > 0 ? "human_review" : "continue_lane",
          reasons,
        };
      },
    }),

    continue_lane: acp({
      profile: "codex",
      async prompt({ outputs }) {
        return [
          "We are continuing on the autonomous lane.",
          "The runtime routed here because the earlier checks did not raise blockers.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "route": "continue",',
          '  "summary": "short explanation",',
          '  "next_actions": ["action", "action"],',
          '  "residual_risks": ["risk", "risk"]',
          "}",
          "",
          `Runtime reasons: ${JSON.stringify((outputs.route as { reasons?: string[] }).reasons ?? [])}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    human_review: acp({
      profile: "codex",
      async prompt({ outputs }) {
        return [
          "We are routing this PR to human review.",
          "Return exactly one JSON object with this shape:",
          "{",
          '  "route": "human_review",',
          '  "summary": "short explanation",',
          '  "blocking_reasons": ["reason", "reason"],',
          '  "questions_for_human": ["question", "question"]',
          "}",
          "",
          `Runtime reasons: ${JSON.stringify((outputs.route as { reasons?: string[] }).reasons ?? [])}`,
        ].join("\n");
      },
      parse: (text) => extractJsonObject(text),
    }),

    finalize: compute({
      run: ({ outputs, state }) => {
        const route = outputs.route as {
          next: string;
          reasons?: string[];
        };
        const branch =
          route.next === "continue_lane" ? outputs.continue_lane : outputs.human_review;

        return {
          route: (branch as { route?: string }).route,
          routeReasons: route.reasons ?? [],
          final: branch,
          sessionBindings: state.sessionBindings,
        };
      },
    }),
  },
  edges: [
    { from: "load_pr", to: "solution_fit" },
    { from: "solution_fit", to: "issue_clarity" },
    { from: "issue_clarity", to: "scope_assessment" },
    { from: "scope_assessment", to: "route" },
    {
      from: "route",
      switch: {
        on: "$.next",
        cases: {
          continue_lane: "continue_lane",
          human_review: "human_review",
        },
      },
    },
    { from: "continue_lane", to: "finalize" },
    { from: "human_review", to: "finalize" },
  ],
});
