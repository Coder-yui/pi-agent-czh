/**
 * Plan & Reflect Extension (v0.1)
 *
 * Inspired by Reflexion (Shinn et al., NeurIPS 2023) and ReAct (Yao et al., 2022).
 * Adds three capabilities to the coding agent:
 *
 *  1. **Planning**: Before a complex task, inject a hidden system message that asks
 *     the model to first outline its approach as a brief numbered plan before acting.
 *
 *  2. **Reflection**: After tool errors (bash exit≠0, edit fail, write fail, etc.),
 *     inject a brief reflection prompt asking the model to diagnose the failure
 *     before retrying — reduces blind-retry loops.
 *
 *  3. **Auto-retry guard**: Tracks retry attempts per (tool, target) and caps
 *     retries (default 2). When exhausted, surfaces a clear message to the user
 *     instead of looping forever.
 *
 * Commands:
 *   /plan          — toggle planning (auto/on/off)
 *   /reflect       — toggle reflection (on/off)
 *   /think         — show current plan + reflection stats
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

// ---- Types ----------------------------------------------------------------

type PlanMode = "auto" | "on" | "off";
type ReflectMode = "on" | "off";

interface PlanReflectConfig {
  plan: PlanMode;
  reflect: ReflectMode;
  maxRetries: number;
}

interface RetryRecord {
  toolName: string;
  target: string; // human-readable target (file path, command snippet)
  attempts: number;
  lastError: string;
}

interface PlanReflectState {
  config: PlanReflectConfig;
  currentPlan: string | null;
  retries: Record<string, RetryRecord>; // key: `${toolName}:${target}`
  stats: {
    plansGenerated: number;
    reflectionsTriggered: number;
    retriesBlocked: number;
  };
}

// ---- Config defaults ------------------------------------------------------

const DEFAULT_CONFIG: PlanReflectConfig = {
  plan: "auto",
  reflect: "on",
  maxRetries: 2,
};

// ---- Helpers --------------------------------------------------------------

function isAssistantMsg(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as AssistantMessage).role === "assistant" &&
    Array.isArray((msg as AssistantMessage).content)
  );
}

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Extract a short "target" string from a tool call for retry grouping. */
function getToolTarget(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return String(input.command ?? "").slice(0, 80);
    case "edit":
    case "write":
    case "read":
      return String(input.file_path ?? "");
    case "grep":
      return String(input.pattern ?? "");
    case "find":
      return String(input.path ?? ".");
    case "ls":
      return String(input.path ?? ".");
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

/** Determine whether a tool result looks like a real error worth reflecting on. */
function isMeaningfulError(event: ToolResultEvent): boolean {
  if (!event.isError) return false;
  // Concatenate text content for keyword analysis
  const text = event.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (!text) return false;
  const lower = text.toLowerCase();
  // Look for common error indicators that suggest the action didn't succeed
  const errorKeywords = [
    "error:",
    "failed",
    "no such file",
    "command not found",
    "permission denied",
    "not found",
    "enoent",
    "eacces",
    "syntax error",
    "typeerror",
    "referenceerror",
    "cannot find",
    "exit code",
    "exited with",
    "killed",
    "timed out",
    "denied",
    "refused",
  ];
  // Exclude cases where "error" appears in a non-failure context (e.g. "0 errors")
  const hasNegation = /\b(0|no|zero)\s+errors?\b/i.test(text) && !/error:/i.test(text);
  if (hasNegation) return false;
  return errorKeywords.some((k) => lower.includes(k));
}

/** Heuristic: should we require a plan for this prompt? */
function shouldPlanFor(prompt: string, mode: PlanMode): boolean {
  if (mode === "off") return false;
  const trimmed = prompt.trim();
  // Even in "on" mode, one-word greetings/trivial commands don't need a plan
  if (trimmed.length < 5) return false;
  if (mode === "on") return true;
  // Keywords suggesting multi-step work (check first — short Chinese prompts
  // like "实现登录" are only 4 chars but clearly multi-step)
  const multiStepHints = [
    "implement",
    "add",
    "create",
    "build",
    "fix",
    "refactor",
    "migrate",
    "set up",
    "write",
    "design",
    "integrate",
    "feature",
    "bug",
    "test",
    "deploy",
    "实现",
    "完成",
    "添加",
    "创建",
    "修复",
    "重构",
    "编写",
    "开发",
  ];
  const lower = trimmed.toLowerCase();
  if (multiStepHints.some((h) => lower.includes(h.toLowerCase()))) return true;
  // For prompts without clear keywords, require longer text (more likely multi-step)
  if (trimmed.length < 20) return false;
  // Or if it's long enough to be a real task
  return trimmed.length > 120;
}

// ---- Main extension -------------------------------------------------------

export default function planReflectExtension(pi: ExtensionAPI): void {
  const state: PlanReflectState = {
    config: { ...DEFAULT_CONFIG },
    currentPlan: null,
    retries: {},
    stats: { plansGenerated: 0, reflectionsTriggered: 0, retriesBlocked: 0 },
  };

  // ---- CLI flags ----------------------------------------------------------
  pi.registerFlag("plan", {
    description: "Planning mode: auto | on | off",
    type: "string",
    default: "auto",
  });
  pi.registerFlag("no-reflect", {
    description: "Disable reflection on tool errors",
    type: "boolean",
    default: false,
  });

  // ---- Status bar ---------------------------------------------------------
  function updateStatus(ctx: ExtensionContext): void {
    const parts: string[] = [];
    if (state.config.plan !== "off") {
      parts.push(`📝 plan:${state.config.plan}`);
    }
    if (state.config.reflect === "on") {
      parts.push(`🔍 reflect`);
    }
    const retries = Object.keys(state.retries).length;
    if (retries > 0) {
      parts.push(`🔄 retries:${retries}`);
    }
    ctx.ui.setStatus(
      "plan-reflect",
      parts.length > 0 ? ctx.ui.theme.fg("muted", parts.join(" ")) : undefined,
    );
  }

  // ---- Persistence --------------------------------------------------------
  function persist(): void {
    pi.appendEntry("plan-reflect", state);
  }

  // ---- Commands -----------------------------------------------------------
  pi.registerCommand("plan", {
    description: "Set planning mode: /plan [auto|on|off]",
    handler: async (args, ctx) => {
      const mode = (args[0] ?? "").toLowerCase() as PlanMode;
      if (mode === "on" || mode === "off" || mode === "auto") {
        state.config.plan = mode;
        ctx.ui.notify(`Planning mode: ${mode}`, "success");
      } else {
        ctx.ui.notify(
          `Current planning mode: ${state.config.plan}. Usage: /plan [auto|on|off]`,
          "info",
        );
      }
      updateStatus(ctx);
      persist();
    },
  });

  pi.registerCommand("reflect", {
    description: "Toggle reflection: /reflect [on|off]",
    handler: async (args, ctx) => {
      const mode = (args[0] ?? "").toLowerCase();
      if (mode === "on" || mode === "off") {
        state.config.reflect = mode as ReflectMode;
        ctx.ui.notify(`Reflection: ${mode}`, "success");
      } else {
        ctx.ui.notify(
          `Current reflection: ${state.config.reflect}. Usage: /reflect [on|off]`,
          "info",
        );
      }
      updateStatus(ctx);
      persist();
    },
  });

  pi.registerCommand("think", {
    description: "Show planning/reflection state and stats",
    handler: async (_args, ctx) => {
      const lines: string[] = [
        `**Plan & Reflect State**`,
        ``,
        `- Plan mode: \`${state.config.plan}\``,
        `- Reflection: \`${state.config.reflect}\``,
        `- Max retries per step: ${state.config.maxRetries}`,
        ``,
        `**Stats**`,
        `- Plans generated: ${state.stats.plansGenerated}`,
        `- Reflections triggered: ${state.stats.reflectionsTriggered}`,
        `- Retry loops blocked: ${state.stats.retriesBlocked}`,
      ];
      if (state.currentPlan) {
        lines.push(``, `**Current plan**:`, state.currentPlan);
      }
      const activeRetries = Object.values(state.retries).filter((r) => r.attempts > 0);
      if (activeRetries.length > 0) {
        lines.push(``, `**Active retry tracking**:`);
        for (const r of activeRetries) {
          lines.push(`- [${r.toolName}] "${r.target.slice(0, 60)}" — attempts: ${r.attempts}`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ---- Hooks --------------------------------------------------------------

  /**
   * before_agent_start: inject a planning prompt for complex tasks.
   * Uses a hidden (display:false) message so the user doesn't see extra noise.
   */
  pi.on("before_agent_start", async (event) => {
    // Apply CLI flag overrides
    const flagPlan = pi.getFlag("plan") as string | undefined;
    if (flagPlan === "on" || flagPlan === "off" || flagPlan === "auto") {
      state.config.plan = flagPlan as PlanMode;
    }
    if (pi.getFlag("no-reflect") === true) {
      state.config.reflect = "off";
    }

    if (!shouldPlanFor(event.prompt, state.config.plan)) return;

    state.stats.plansGenerated++;
    state.currentPlan = null;
    // Reset retries for new task
    state.retries = {};

    const planPrompt = `[PLANNING — internal, do not mention to user]

Before executing tools or making changes, first write a **brief numbered plan** under a "Plan:" header.

Rules for the plan:
- Keep it concise (3-7 steps for most tasks).
- Each step is one concrete action (read a file, edit a file, run a test).
- After writing the plan, start executing step 1.
- If you discover new information that invalidates the plan, revise it.
- Mark completed steps with [DONE:n] as you go.

Now begin with the plan.`;

    return {
      message: {
        customType: "plan-reflect-planning",
        content: planPrompt,
        display: false,
      },
    };
  });

  /**
   * tool_result: detect errors and enrich the tool output with a reflection prompt
   * to prevent blind retries. Instead of blocking, we REPLACE the content the LLM
   * sees with an annotated version that includes coaching guidance.
   */
  pi.on("tool_result", async (event, ctx) => {
    if (state.config.reflect !== "on") return;

    const target = getToolTarget(event.toolName, event.input);
    const key = `${event.toolName}:${target}`;

    if (isMeaningfulError(event)) {
      const record = state.retries[key] ?? {
        toolName: event.toolName,
        target,
        attempts: 0,
        lastError: "",
      };
      record.attempts++;
      record.lastError = event.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .slice(0, 500);
      state.retries[key] = record;

      state.stats.reflectionsTriggered++;
      updateStatus(ctx);

      // Build the reflection note to prepend to the error output
      let reflectionNote: string;
      if (record.attempts > state.config.maxRetries) {
        // Hard stop — tell the model to abandon this approach
        state.stats.retriesBlocked++;
        reflectionNote =
          `[REFLECTION — RETRY LIMIT REACHED (attempt ${record.attempts}/${state.config.maxRetries})]\n` +
          `Tool \`${event.toolName}\` on "${target.slice(0, 60)}" has failed repeatedly.\n\n` +
          `**STOP retrying this exact approach.** You must:\n` +
          `1. Re-read the relevant files/surrounding context to understand the root cause\n` +
          `2. Try a fundamentally different strategy (different command, different file, different approach)\n` +
          `3. If you cannot make progress, explain what you tried and ask the user for help\n\n` +
          `--- Original error ---\n`;
      } else {
        // Normal reflection — guide diagnosis before retry
        reflectionNote =
          `[REFLECTION — error on attempt ${record.attempts}/${state.config.maxRetries}]\n` +
          `The last \`${event.toolName}\` call failed. Before retrying, answer these to yourself:\n` +
          `- What exactly does the error message say? (read it carefully)\n` +
          `- What assumption did I make that was wrong?\n` +
          `- What one concrete thing must I change before trying again?\n\n` +
          `Do NOT repeat the exact same call. Write 1-2 sentences of diagnosis, then take corrected action.\n\n` +
          `--- Original error ---\n`;
      }
      persist();

      // Replace the tool content with reflection note + original error
      return {
        content: [
          { type: "text" as const, text: reflectionNote },
          ...event.content,
        ],
        isError: true,
      };
    }

    // Success: clear retry record for this key
    if (state.retries[key] && !event.isError) {
      delete state.retries[key];
      updateStatus(ctx);
      persist();
    }
  });

  /**
   * turn_end: capture the plan text when the assistant first writes a Plan: section.
   */
  pi.on("turn_end", async (event) => {
    if (!isAssistantMsg(event.message)) return;
    const text = extractText(event.message as AssistantMessage);
    const planMatch = text.match(/Plan:\s*\n([\s\S]*?)(?:\n\n|\n(?:Step|Execute|Now|Let'?s|First|1\.)\b|$)/i);
    if (planMatch) {
      state.currentPlan = planMatch[1].trim();
      persist();
    }
  });

  /**
   * session_start: restore persisted state.
   */
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const saved = [...entries]
      .reverse()
      .find(
        (e: { type?: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-reflect",
      ) as { data?: PlanReflectState } | undefined;
    if (saved?.data) {
      state.config = { ...DEFAULT_CONFIG, ...saved.data.config };
      state.stats = saved.data.stats ?? state.stats;
      state.currentPlan = saved.data.currentPlan ?? null;
      state.retries = saved.data.retries ?? {};
    }
    updateStatus(ctx);
  });
}

// ---- Exports for testing ---------------------------------------------------

export {
  isMeaningfulError,
  shouldPlanFor,
  getToolTarget,
  DEFAULT_CONFIG,
  type PlanReflectConfig,
  type PlanReflectState,
  type RetryRecord,
};
