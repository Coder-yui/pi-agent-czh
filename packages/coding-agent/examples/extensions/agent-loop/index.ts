/**
 * Agent Loop extension.
 *
 * The control model follows Google ADK LoopAgent's deterministic semantics:
 * execute a full agent run, require an explicit continue/complete/blocked
 * checkpoint, and always enforce iteration/time/tool-call ceilings.
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_ENTRY = "agent-loop-state";
const CHECKPOINT_TOOL = "agent_loop_checkpoint";
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_MAX_TOOL_CALLS = 50;
const DEFAULT_TIMEOUT_MINUTES = 30;
const MAX_ITERATIONS_LIMIT = 50;
const MAX_TOOL_CALLS_LIMIT = 1000;
const MAX_TIMEOUT_MINUTES = 24 * 60;

type LoopStatus = "running" | "paused" | "completed" | "blocked" | "exhausted" | "stopped";
type CheckpointStatus = "continue" | "complete" | "blocked";

interface LoopCheckpoint {
	iteration: number;
	status: CheckpointStatus;
	summary: string;
	evidence: string;
	nextAction?: string;
	createdAt: number;
}

interface AgentLoopState {
	version: 1;
	id: string;
	goal: string;
	status: LoopStatus;
	iteration: number;
	maxIterations: number;
	toolCalls: number;
	maxToolCalls: number;
	startedAt: number;
	updatedAt: number;
	deadlineAt: number;
	checkpointRecorded: boolean;
	checkpoints: LoopCheckpoint[];
	reason?: string;
}

interface LoopStartOptions {
	goal: string;
	maxIterations: number;
	maxToolCalls: number;
	timeoutMinutes: number;
}

interface LoopToolDetails {
	state: AgentLoopState | null;
}

const CheckpointParams = Type.Object({
	status: StringEnum(["continue", "complete", "blocked"] as const, {
		description: "Whether the goal needs another iteration, is complete, or cannot proceed without help",
	}),
	summary: Type.String({ minLength: 1, description: "Concrete progress made in this iteration" }),
	evidence: Type.String({ minLength: 1, description: "Tests, files, outputs, or observations supporting the status" }),
	next_action: Type.Optional(Type.String({ description: "Specific action for the next iteration" })),
});

function cloneState(state: AgentLoopState | null): AgentLoopState | null {
	return state ? structuredClone(state) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentLoopState(value: unknown): value is AgentLoopState {
	if (!isRecord(value) || value.version !== 1) return false;
	return (
		typeof value.id === "string" &&
		typeof value.goal === "string" &&
		typeof value.status === "string" &&
		typeof value.iteration === "number" &&
		typeof value.maxIterations === "number" &&
		typeof value.toolCalls === "number" &&
		typeof value.maxToolCalls === "number" &&
		typeof value.startedAt === "number" &&
		typeof value.updatedAt === "number" &&
		typeof value.deadlineAt === "number" &&
		typeof value.checkpointRecorded === "boolean" &&
		Array.isArray(value.checkpoints)
	);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`Expected an integer from ${minimum} to ${maximum}, received ${value}`);
	}
	return parsed;
}

function consumeNumericOption(input: string, option: string): { remaining: string; value?: string } {
	const pattern = new RegExp(`(?:^|\\s)--${option}(?:=|\\s+)(\\d+)(?=\\s|$)`);
	const match = input.match(pattern);
	if (!match) return { remaining: input };
	return {
		remaining: `${input.slice(0, match.index)} ${input.slice((match.index ?? 0) + match[0].length)}`.trim(),
		value: match[1],
	};
}

function parseStartOptions(input: string): LoopStartOptions {
	const iterations = consumeNumericOption(input, "max-iterations");
	const tools = consumeNumericOption(iterations.remaining, "max-tools");
	const timeout = consumeNumericOption(tools.remaining, "timeout-minutes");
	const goal = timeout.remaining.replace(/\s+/g, " ").trim();
	if (!goal) {
		throw new Error("A loop goal is required");
	}
	return {
		goal,
		maxIterations: boundedInteger(iterations.value, DEFAULT_MAX_ITERATIONS, 1, MAX_ITERATIONS_LIMIT),
		maxToolCalls: boundedInteger(tools.value, DEFAULT_MAX_TOOL_CALLS, 1, MAX_TOOL_CALLS_LIMIT),
		timeoutMinutes: boundedInteger(timeout.value, DEFAULT_TIMEOUT_MINUTES, 1, MAX_TIMEOUT_MINUTES),
	};
}

function parseResumeOptions(input: string): { guidance: string; maxIterations?: number } {
	const iterations = consumeNumericOption(input, "max-iterations");
	return {
		guidance: iterations.remaining.replace(/\s+/g, " ").trim(),
		maxIterations:
			iterations.value === undefined
				? undefined
				: boundedInteger(iterations.value, DEFAULT_MAX_ITERATIONS, 1, MAX_ITERATIONS_LIMIT),
	};
}

function formatState(state: AgentLoopState | null): string {
	if (!state) return "No Agent Loop has been created in this session.";
	const latest = state.checkpoints.at(-1);
	return [
		`Agent Loop ${state.id}`,
		`Status: ${state.status}`,
		`Goal: ${state.goal}`,
		`Iteration: ${state.iteration}/${state.maxIterations}`,
		`Tool calls: ${state.toolCalls}/${state.maxToolCalls}`,
		`Deadline: ${new Date(state.deadlineAt).toISOString()}`,
		state.reason ? `Reason: ${state.reason}` : undefined,
		latest ? `Latest checkpoint: ${latest.status} — ${latest.summary}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function continuationPrompt(state: AgentLoopState): string {
	const latest = state.checkpoints.at(-1);
	return `[Agent Loop ${state.id}: iteration ${state.iteration}/${state.maxIterations}]

Continue working toward this unchanged goal:
${state.goal}

Previous checkpoint:
- Progress: ${latest?.summary ?? "No checkpoint summary"}
- Evidence: ${latest?.evidence ?? "No checkpoint evidence"}
- Next action: ${latest?.nextAction ?? "Choose the most useful next action"}

Do not merely restate the checkpoint. Perform the next concrete work, verify it, then call ${CHECKPOINT_TOOL} exactly once.`;
}

function systemPromptFor(state: AgentLoopState): string {
	return `## Active Agent Loop

You are executing a deterministic, bounded Agent Loop.

- Loop ID: ${state.id}
- Goal: ${state.goal}
- Iteration: ${state.iteration}/${state.maxIterations}
- Tool calls used: ${state.toolCalls}/${state.maxToolCalls}
- Deadline: ${new Date(state.deadlineAt).toISOString()}

Work on the goal using the normal pi tools. Before ending this agent run, call \`${CHECKPOINT_TOOL}\` exactly once:

- \`continue\`: meaningful work was completed but the goal still needs another iteration; include a concrete next action.
- \`complete\`: the goal and verification criteria are actually satisfied; cite evidence.
- \`blocked\`: progress requires user input or unavailable authority; state the blocker precisely.

Do not claim completion without evidence. The harness, not the model, enforces iteration, tool-call, and time limits.`;
}

export default function agentLoopExtension(pi: ExtensionAPI): void {
	let state: AgentLoopState | null = null;

	function persist(): void {
		if (state) pi.appendEntry(STATE_ENTRY, cloneState(state));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state) {
			ctx.ui.setStatus("agent-loop", undefined);
			return;
		}
		ctx.ui.setStatus(
			"agent-loop",
			`Loop ${state.status} ${state.iteration}/${state.maxIterations} tools ${state.toolCalls}/${state.maxToolCalls}`,
		);
	}

	function stopWith(status: Exclude<LoopStatus, "running">, reason: string, ctx: ExtensionContext): void {
		if (!state) return;
		state.status = status;
		state.reason = reason;
		state.updatedAt = Date.now();
		persist();
		updateStatus(ctx);
	}

	function restore(ctx: ExtensionContext): void {
		const saved = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY);
		state = saved?.type === "custom" && isAgentLoopState(saved.data) ? structuredClone(saved.data) : null;
		if (state?.status === "running") {
			state.status = "paused";
			state.reason = "Session was reloaded; use /agent-loop resume to continue explicitly.";
			state.updatedAt = Date.now();
			persist();
		}
		updateStatus(ctx);
	}

	pi.registerTool({
		name: CHECKPOINT_TOOL,
		label: "Agent Loop Checkpoint",
		description:
			"Record the required end-of-iteration decision for an active Agent Loop. This does not start loops; users start them with /agent-loop start.",
		promptSnippet: "Record continue/complete/blocked status for an active bounded Agent Loop",
		parameters: CheckpointParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state || state.status !== "running") {
				return {
					content: [{ type: "text", text: "No running Agent Loop accepts a checkpoint." }],
					details: { state: cloneState(state) } satisfies LoopToolDetails,
					isError: true,
				};
			}
			if (state.checkpointRecorded) {
				return {
					content: [{ type: "text", text: "A checkpoint was already recorded for this iteration." }],
					details: { state: cloneState(state) } satisfies LoopToolDetails,
					isError: true,
				};
			}

			const checkpoint: LoopCheckpoint = {
				iteration: state.iteration,
				status: params.status,
				summary: params.summary.trim(),
				evidence: params.evidence.trim(),
				nextAction: params.next_action?.trim() || undefined,
				createdAt: Date.now(),
			};
			state.checkpoints.push(checkpoint);
			state.checkpointRecorded = true;
			state.updatedAt = checkpoint.createdAt;
			if (checkpoint.status === "complete") {
				state.status = "completed";
				state.reason = checkpoint.summary;
			} else if (checkpoint.status === "blocked") {
				state.status = "blocked";
				state.reason = checkpoint.summary;
			}
			persist();
			updateStatus(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							checkpoint.status === "continue"
								? "Checkpoint recorded. The harness will schedule the next bounded iteration after this run ends."
								: `Checkpoint recorded. Loop status is now ${state.status}.`,
					},
				],
				details: { state: cloneState(state) } satisfies LoopToolDetails,
			};
		},
	});

	pi.registerCommand("agent-loop", {
		description: "Manage bounded autonomous iteration: /agent-loop start|status|pause|resume|stop [options]",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
			const action = match?.[1]?.toLowerCase() ?? "status";
			const remainder = match?.[2] ?? "";
			try {
				switch (action) {
					case "start": {
						if (state?.status === "running") throw new Error("An Agent Loop is already running");
						const options = parseStartOptions(remainder);
						const now = Date.now();
						state = {
							version: 1,
							id: randomUUID(),
							goal: options.goal,
							status: "running",
							iteration: 1,
							maxIterations: options.maxIterations,
							toolCalls: 0,
							maxToolCalls: options.maxToolCalls,
							startedAt: now,
							updatedAt: now,
							deadlineAt: now + options.timeoutMinutes * 60_000,
							checkpointRecorded: false,
							checkpoints: [],
						};
						persist();
						updateStatus(ctx);
						pi.sendUserMessage(
							`[Agent Loop ${state.id}: iteration 1/${state.maxIterations}]\n\nGoal: ${state.goal}\n\nPerform concrete work, verify it, then call ${CHECKPOINT_TOOL} exactly once.`,
						);
						return;
					}
					case "status":
						ctx.ui.notify(formatState(state), "info");
						return;
					case "pause":
						if (!state || state.status !== "running") throw new Error("No Agent Loop is running");
						stopWith("paused", "Paused by user.", ctx);
						return;
					case "resume": {
						if (!state || !["paused", "blocked", "stopped", "exhausted"].includes(state.status)) {
							throw new Error("No paused, blocked, stopped, or exhausted Agent Loop can be resumed");
						}
						const options = parseResumeOptions(remainder);
						if (options.maxIterations !== undefined) state.maxIterations = options.maxIterations;
						if (state.iteration >= state.maxIterations) {
							throw new Error("Increase --max-iterations above the current iteration before resuming");
						}
						state.iteration += 1;
						state.status = "running";
						state.reason = undefined;
						state.checkpointRecorded = false;
						state.updatedAt = Date.now();
						persist();
						updateStatus(ctx);
						pi.sendUserMessage(
							`${continuationPrompt(state)}${options.guidance ? `\n\nUser guidance: ${options.guidance}` : ""}`,
						);
						return;
					}
					case "stop":
						if (!state) throw new Error("No Agent Loop exists");
						stopWith("stopped", "Stopped by user.", ctx);
						return;
					default:
						throw new Error(
							"Usage: /agent-loop start <goal> [--max-iterations=N --max-tools=N --timeout-minutes=N] | status | pause | resume | stop",
						);
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!state || state.status !== "running") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${systemPromptFor(state)}` };
	});

	pi.on("tool_call", (event, ctx) => {
		if (!state || state.status !== "running" || event.toolName === CHECKPOINT_TOOL) return;
		if (Date.now() >= state.deadlineAt) {
			stopWith("exhausted", "Agent Loop time budget is exhausted.", ctx);
			return { block: true, terminate: true, reason: "Agent Loop time budget is exhausted." };
		}
		if (state.toolCalls >= state.maxToolCalls) {
			stopWith("exhausted", "Agent Loop tool-call budget is exhausted.", ctx);
			return { block: true, terminate: true, reason: "Agent Loop tool-call budget is exhausted." };
		}
		state.toolCalls += 1;
		state.updatedAt = Date.now();
		persist();
		updateStatus(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!state || state.status !== "running") return;
		if (!state.checkpointRecorded) {
			stopWith("paused", `Iteration ${state.iteration} ended without ${CHECKPOINT_TOOL}.`, ctx);
			return;
		}
		const checkpoint = state.checkpoints.at(-1);
		if (checkpoint?.status !== "continue") return;
		if (Date.now() >= state.deadlineAt) {
			stopWith("exhausted", "Time budget reached after the latest checkpoint.", ctx);
			return;
		}
		if (state.toolCalls >= state.maxToolCalls) {
			stopWith("exhausted", "Tool-call budget reached after the latest checkpoint.", ctx);
			return;
		}
		if (state.iteration >= state.maxIterations) {
			stopWith("exhausted", "Maximum iteration count reached.", ctx);
			return;
		}

		state.iteration += 1;
		state.checkpointRecorded = false;
		state.updatedAt = Date.now();
		persist();
		updateStatus(ctx);
		pi.sendUserMessage(continuationPrompt(state), { deliverAs: "followUp" });
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (state?.status === "running") {
			stopWith("paused", "Session shut down; resume explicitly in a loaded session.", ctx);
		}
	});
}

export {
	CHECKPOINT_TOOL,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_MAX_TOOL_CALLS,
	DEFAULT_TIMEOUT_MINUTES,
	formatState,
	parseResumeOptions,
	parseStartOptions,
	systemPromptFor,
	type AgentLoopState,
	type LoopCheckpoint,
	type LoopStartOptions,
	type LoopStatus,
};
