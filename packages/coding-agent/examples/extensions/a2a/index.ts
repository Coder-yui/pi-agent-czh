/**
 * A2A (Agent2Agent) Protocol extension for pi.
 *
 * Two capabilities:
 *  (1) A2A Server — expose pi as an A2A agent over HTTP+JSON-RPC, so other
 *      agents can discover it via /.well-known/agent-card.json and send tasks.
 *  (2) A2A Client — register `a2a_delegate` and `a2a_discover` tools that let
 *      pi send subtasks to remote A2A agents and collect their results.
 *
 * Commands:
 *   /a2a start [port]  — start A2A server (default port 41241)
 *   /a2a stop          — stop the server
 *   /a2a status        — show server status
 *   /a2a discover <url> — fetch and display a remote agent card
 *
 * Reference: https://a2a-protocol.org/  (A2A Protocol v1.0, Linux Foundation)
 * SDK: @a2a-js/sdk ^1.0.1 (official TypeScript SDK)
 */

import { randomUUID } from "node:crypto";
import {
	A2A_PROTOCOL_VERSION,
	AGENT_CARD_PATH,
	type AgentCard,
	type Artifact,
	type Message,
	type Part,
	Role,
	type Task,
	type TaskArtifactUpdateEvent,
	TaskState,
	type TaskStatus,
	type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import {
	AgentEvent,
	type AgentExecutor,
	DefaultRequestHandler,
	type ExecutionEventBus,
	InMemoryTaskStore,
	type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import express from "express";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textPart(text: string): Part {
	return {
		content: { $case: "text", value: text },
		filename: "",
		mediaType: "text/plain",
		metadata: undefined,
	};
}

function extractTextFromMessage(message: Message): string {
	const parts: string[] = [];
	for (const part of message.parts) {
		if (part.content?.$case === "text") {
			parts.push(part.content.value);
		}
	}
	const text = parts.join("\n\n").trim();
	return text || "(empty message)";
}

function extractTextFromAssistantMessage(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function extractTextFromArtifact(artifact: Artifact): string {
	const parts: string[] = [];
	for (const part of artifact.parts) {
		if (part.content?.$case === "text") parts.push(part.content.value);
	}
	return parts.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validateAgentUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("A2A agent URL must use http or https");
	}
	if (url.username || url.password) throw new Error("A2A agent URL must not contain credentials");
	if (url.hostname === "169.254.169.254" || url.hostname.toLowerCase() === "metadata.google.internal") {
		throw new Error("Cloud metadata endpoints are not valid A2A agents");
	}
	return url;
}

async function createA2AClient(agentUrl: string, signal: AbortSignal) {
	const url = validateAgentUrl(agentUrl);
	const fetchWithSignal: typeof fetch = (input, init) => {
		const combinedSignal = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
		return fetch(input, { ...init, signal: combinedSignal });
	};
	const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
		cardResolver: new DefaultAgentCardResolver({ fetchImpl: fetchWithSignal }),
	});
	return new ClientFactory(options).createFromUrl(url.toString());
}

function extractTextFromTask(task: Task): string {
	// Collect text from all artifacts
	const texts: string[] = [];
	if (task.artifacts) {
		for (const art of task.artifacts) {
			const t = extractTextFromArtifact(art);
			if (t) texts.push(t);
		}
	}
	return texts.join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Agent Card for pi
// ---------------------------------------------------------------------------

function createPiAgentCard(port: number): AgentCard {
	return {
		name: "pi Coding Agent",
		description:
			"A text-based pi model endpoint for coding questions, explanations, and code generation. A2A requests do not receive filesystem, shell, or extension-tool access.",
		supportedInterfaces: [
			{
				url: `http://localhost:${port}/`,
				protocolBinding: "JSONRPC",
				tenant: "",
				protocolVersion: A2A_PROTOCOL_VERSION,
			},
		],
		provider: {
			organization: "pi-agent-czh",
			url: "https://github.com/Coder-yui/pi-agent-czh",
		},
		version: "0.1.0",
		capabilities: {
			streaming: true,
			pushNotifications: false,
			extensions: [],
			extendedAgentCard: false,
		},
		securitySchemes: {},
		securityRequirements: [],
		defaultInputModes: ["text"],
		defaultOutputModes: ["text", "task-status"],
		skills: [
			{
				id: "coding-advice",
				name: "Coding Advice and Generation",
				description:
					"Answer coding questions, explain code, and generate suggested code through direct model inference without tool execution.",
				tags: ["coding", "programming", "explanation", "generation"],
				examples: [
					"Write a Python function to parse CSV files",
					"Explain what this code does",
					"Suggest a refactoring approach",
				],
				inputModes: ["text"],
				outputModes: ["text", "task-status"],
				securityRequirements: [],
			},
		],
		documentationUrl: "https://github.com/Coder-yui/pi-agent-czh",
		signatures: [],
	};
}

// ---------------------------------------------------------------------------
// AgentExecutor: bridges A2A tasks → pi model responses
// ---------------------------------------------------------------------------

interface A2ARuntime {
	model: Model<Api>;
	modelRegistry: ModelRegistry;
}

interface RunningTask {
	controller: AbortController;
	contextId: string;
	terminalPublished: boolean;
}

class PiA2AExecutor implements AgentExecutor {
	private readonly runningTasks = new Map<string, RunningTask>();
	private readonly getModel: () => A2ARuntime | null;

	constructor(getModel: () => A2ARuntime | null) {
		this.getModel = getModel;
	}

	cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
		const runningTask = this.runningTasks.get(taskId);
		if (!runningTask) return;
		runningTask.controller.abort(new Error("A2A task canceled by client"));
		this.publishCanceled(eventBus, taskId, runningTask.contextId);
		runningTask.terminalPublished = true;
	};

	async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
		const userMessage = requestContext.userMessage;
		const existingTask = requestContext.task;
		const taskId = requestContext.taskId;
		const contextId = requestContext.contextId;
		const runningTask: RunningTask = {
			controller: new AbortController(),
			contextId,
			terminalPublished: false,
		};
		this.runningTasks.set(taskId, runningTask);

		try {
			// 1. Publish initial Task snapshot (required as first event)
			const initialStatus: TaskStatus = {
				state: TaskState.TASK_STATE_SUBMITTED,
				message: undefined,
				timestamp: new Date().toISOString(),
			};
			const taskSnapshot: Task = existingTask ?? {
				id: taskId,
				contextId,
				status: initialStatus,
				artifacts: [],
				history: [userMessage],
				metadata: userMessage.metadata,
			};
			eventBus.publish(AgentEvent.task(taskSnapshot));

			// 2. Publish working status
			const workingStatusMsg: Message = {
				role: Role.ROLE_AGENT,
				messageId: randomUUID(),
				contextId,
				taskId,
				parts: [textPart("Processing your request with pi...")],
				metadata: {},
				extensions: [],
				referenceTaskIds: [],
			};
			const workingUpdate: TaskStatusUpdateEvent = {
				taskId,
				contextId,
				status: {
					state: TaskState.TASK_STATE_WORKING,
					message: workingStatusMsg,
					timestamp: new Date().toISOString(),
				},
				metadata: {},
			};
			eventBus.publish(AgentEvent.statusUpdate(workingUpdate));

			// 3. Extract text and call the model
			const userText = extractTextFromMessage(userMessage);
			const runtime = this.getModel();
			if (!runtime) {
				this.publishFailed(
					eventBus,
					taskId,
					contextId,
					"A2A server is running but no model is selected. Configure a model before sending tasks.",
				);
				runningTask.terminalPublished = true;
				return;
			}

			const systemPrompt = `You are pi, a terminal-first AI coding agent exposed via the A2A (Agent2Agent) protocol.
You are responding to a task delegated to you by another agent.
Provide clear, concise, actionable responses. If the task involves code, write correct, well-structured code.
Be direct and helpful. Do not include unnecessary preamble.`;

			const stream = runtime.modelRegistry.stream(
				runtime.model,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
				},
				{ signal: AbortSignal.any([runningTask.controller.signal, AbortSignal.timeout(120_000)]) },
			);
			const artifactId = randomUUID();
			let pendingDelta = "";
			let publishedChunk = false;
			let finalResponse = "";
			for await (const modelEvent of stream) {
				if (modelEvent.type === "text_delta") {
					if (pendingDelta) {
						this.publishArtifactChunk(
							eventBus,
							taskId,
							contextId,
							artifactId,
							pendingDelta,
							publishedChunk,
							false,
						);
						publishedChunk = true;
					}
					pendingDelta = modelEvent.delta;
				} else if (modelEvent.type === "done") {
					finalResponse = extractTextFromAssistantMessage(modelEvent.message);
				} else if (modelEvent.type === "error") {
					throw new Error(modelEvent.error.errorMessage ?? `Model request ${modelEvent.reason}`);
				}
			}

			if (pendingDelta) {
				this.publishArtifactChunk(eventBus, taskId, contextId, artifactId, pendingDelta, publishedChunk, true);
			} else if (!publishedChunk) {
				this.publishArtifactChunk(
					eventBus,
					taskId,
					contextId,
					artifactId,
					finalResponse.trim() || "(empty response from model)",
					false,
					true,
				);
			}

			this.publishCompleted(eventBus, taskId, contextId);
			runningTask.terminalPublished = true;
		} catch (error: unknown) {
			if (runningTask.terminalPublished) return;
			if (runningTask.controller.signal.aborted) {
				this.publishCanceled(eventBus, taskId, contextId);
			} else {
				this.publishFailed(eventBus, taskId, contextId, errorMessage(error));
			}
			runningTask.terminalPublished = true;
		} finally {
			this.runningTasks.delete(taskId);
		}
	}

	private publishCanceled(eventBus: ExecutionEventBus, taskId: string, contextId: string) {
		const update: TaskStatusUpdateEvent = {
			taskId,
			contextId,
			status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
			metadata: {},
		};
		eventBus.publish(AgentEvent.statusUpdate(update));
	}

	private publishCompleted(eventBus: ExecutionEventBus, taskId: string, contextId: string) {
		const update: TaskStatusUpdateEvent = {
			taskId,
			contextId,
			status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
			metadata: {},
		};
		eventBus.publish(AgentEvent.statusUpdate(update));
	}

	private publishFailed(eventBus: ExecutionEventBus, taskId: string, contextId: string, errorText: string) {
		const message: Message = {
			role: Role.ROLE_AGENT,
			messageId: randomUUID(),
			contextId,
			taskId,
			parts: [textPart(errorText)],
			metadata: {},
			extensions: [],
			referenceTaskIds: [],
		};
		const update: TaskStatusUpdateEvent = {
			taskId,
			contextId,
			status: {
				state: TaskState.TASK_STATE_FAILED,
				message,
				timestamp: new Date().toISOString(),
			},
			metadata: {},
		};
		eventBus.publish(AgentEvent.statusUpdate(update));
	}

	private publishArtifactChunk(
		eventBus: ExecutionEventBus,
		taskId: string,
		contextId: string,
		artifactId: string,
		text: string,
		append: boolean,
		lastChunk: boolean,
	) {
		const artifact: Artifact = {
			artifactId,
			name: "Result",
			description: "pi's response to the task",
			parts: [textPart(text)],
			metadata: undefined,
			extensions: [],
		};
		const update: TaskArtifactUpdateEvent = {
			taskId,
			contextId,
			artifact,
			lastChunk,
			append,
			metadata: undefined,
		};
		eventBus.publish(AgentEvent.artifactUpdate(update));
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

interface A2AServerState {
	app: express.Express;
	server: ReturnType<express.Express["listen"]>;
	port: number;
}

const DELEGATE_PARAMS = Type.Object({
	agent_url: Type.String({
		description: "Base URL of the remote A2A agent (e.g. http://localhost:41241)",
	}),
	task: Type.String({
		description: "Description of the task to delegate to the remote agent",
	}),
	context: Type.Optional(
		Type.String({
			description: "Optional additional context to provide to the remote agent",
		}),
	),
});

const DISCOVER_PARAMS = Type.Object({
	agent_url: Type.String({ description: "Base URL of the remote A2A agent" }),
});

export default function a2aExtension(pi: ExtensionAPI) {
	let serverState: A2AServerState | null = null;
	let currentRuntime: A2ARuntime | null = null;
	const getCurrentModel = () => currentRuntime;

	// ---- Tools ----

	pi.registerTool({
		name: "a2a_delegate",
		label: "A2A Delegate Task",
		description:
			"Delegate a subtask to a remote A2A (Agent2Agent) agent. Discovers the agent's card from its URL, sends the task via JSON-RPC streaming, collects status updates and artifacts, and returns the final result. Use this when you want another agent to do work for you.",
		promptSnippet: "Delegate a subtask to a remote A2A agent at the given URL",
		promptGuidelines: [
			"Use a2a_delegate when a task would benefit from a specialized remote agent.",
			"Provide a clear, self-contained task description with all necessary context.",
			"The agent_url must be a reachable HTTP base URL (the agent card is at /.well-known/agent-card.json).",
		],
		parameters: DELEGATE_PARAMS,
		async execute(_toolCallId, params, signal) {
			const { agent_url, task, context } = params;
			try {
				const requestSignal = withTimeout(signal, 120_000);
				const client = await createA2AClient(agent_url, requestSignal);

				const messageText = context ? `${task}\n\nAdditional context:\n${context}` : task;
				const userMessage: Message = {
					role: Role.ROLE_USER,
					messageId: randomUUID(),
					contextId: "",
					taskId: "",
					parts: [textPart(messageText)],
					metadata: {},
					extensions: [],
					referenceTaskIds: [],
				};

				let finalText = "";
				const statusLines: string[] = [];
				const artifactTexts = new Map<string, string>();
				let receivedPayload = false;
				let terminalState: TaskState | undefined;

				try {
					const stream = client.sendMessageStream(
						{
							tenant: "",
							message: userMessage,
							configuration: undefined,
							metadata: undefined,
						},
						{ signal: requestSignal },
					);
					for await (const resp of stream) {
						const payload = resp.payload;
						if (!payload) continue;
						receivedPayload = true;
						const kind = payload.$case;
						if (kind === "statusUpdate") {
							const evt = payload.value;
							const state = evt.status?.state;
							terminalState = state;
							const msg = evt.status?.message ? extractTextFromMessage(evt.status.message) : "";
							if (msg) statusLines.push(`- [${state}] ${msg}`);
						} else if (kind === "artifactUpdate") {
							const art = payload.value.artifact;
							if (art) {
								const t = extractTextFromArtifact(art);
								if (payload.value.append) {
									artifactTexts.set(art.artifactId, `${artifactTexts.get(art.artifactId) ?? ""}${t}`);
								} else {
									artifactTexts.set(art.artifactId, t);
								}
							}
						} else if (kind === "task") {
							const t = extractTextFromTask(payload.value);
							if (t && artifactTexts.size === 0) finalText = t;
						} else if (kind === "message") {
							const txt = extractTextFromMessage(payload.value);
							if (txt) finalText += (finalText ? "\n" : "") + txt;
						}
					}
				} catch (error: unknown) {
					if (receivedPayload) throw error;
					const result = await client.sendMessage(
						{
							tenant: "",
							message: userMessage,
							configuration: undefined,
							metadata: undefined,
						},
						{ signal: requestSignal },
					);
					if ("artifacts" in result && result.artifacts) {
						for (const art of result.artifacts) {
							const t = extractTextFromArtifact(art);
							if (t) finalText += (finalText ? "\n\n" : "") + t;
						}
					} else if ("parts" in result) {
						finalText = extractTextFromMessage(result);
					}
				}
				if (artifactTexts.size > 0) finalText = [...artifactTexts.values()].filter(Boolean).join("\n\n");
				if (terminalState === TaskState.TASK_STATE_FAILED) throw new Error("Remote A2A task failed");
				if (terminalState === TaskState.TASK_STATE_CANCELED) throw new Error("Remote A2A task was canceled");

				const card = await client.getAgentCard({ signal: requestSignal });
				const lines = [
					`### Delegated to A2A agent: ${card.name}`,
					"",
					`**URL:** ${agent_url}`,
					`**Agent description:** ${card.description ?? "(none)"}`,
					"",
				];
				if (statusLines.length > 0) {
					lines.push("**Status updates:**", ...statusLines, "");
				}
				lines.push("**Result:**", finalText || "(no text result returned)");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agent_url, task_sent: task },
				};
			} catch (error: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to delegate to A2A agent at ${agent_url}: ${errorMessage(error)}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: "a2a_discover",
		label: "A2A Discover Agent",
		description:
			"Discover a remote A2A agent by fetching and displaying its agent card. Shows name, description, skills, capabilities, and supported protocols. Use this before delegating to understand what the agent can do.",
		promptSnippet: "Discover a remote A2A agent's capabilities",
		parameters: DISCOVER_PARAMS,
		async execute(_toolCallId, params, signal) {
			try {
				const requestSignal = withTimeout(signal, 15_000);
				const client = await createA2AClient(params.agent_url, requestSignal);
				const card = await client.getAgentCard({ signal: requestSignal });

				const info = [
					`### A2A Agent: ${card.name}`,
					"",
					`**Description:** ${card.description ?? "(none)"}`,
					`**Version:** ${card.version ?? "unknown"}`,
					`**Protocol version:** ${A2A_PROTOCOL_VERSION}`,
					`**Provider:** ${card.provider?.organization ?? "unknown"}`,
					"",
					"**Capabilities:**",
					`- Streaming: ${card.capabilities?.streaming ? "yes" : "no"}`,
					`- Push notifications: ${card.capabilities?.pushNotifications ? "yes" : "no"}`,
					"",
					"**Skills:**",
					...(card.skills?.map(
						(s) =>
							`- **${s.name}** (${s.id}): ${s.description}${s.tags?.length ? ` [tags: ${s.tags.join(", ")}]` : ""}`,
					) ?? ["(none)"]),
					"",
					"**Interfaces:**",
					...(card.supportedInterfaces?.map(
						(i) => `- ${i.protocolBinding} @ ${i.url} (v${i.protocolVersion})`,
					) ?? ["(none)"]),
				].join("\n");

				return { content: [{ type: "text", text: info }], details: undefined };
			} catch (error: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to discover agent at ${params.agent_url}: ${errorMessage(error)}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	// ---- Commands ----

	pi.registerCommand("a2a", {
		description: "A2A protocol control: /a2a start [port] | stop | status | discover <url>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcmd = (parts[0] ?? "status").toLowerCase();

			if (subcmd === "start" || subcmd === "on") {
				if (serverState) {
					ctx.ui.notify(`A2A server already running on port ${serverState.port}`, "warning");
					return;
				}
				const port = parseInt(parts[1] ?? "41241", 10);
				if (Number.isNaN(port) || port < 1 || port > 65535) {
					ctx.ui.notify(`Invalid port: ${parts[1]}`, "error");
					return;
				}
				try {
					currentRuntime = ctx.model ? { model: ctx.model, modelRegistry: ctx.modelRegistry } : null;
					serverState = await startServer(getCurrentModel, port);
					ctx.ui.notify(`A2A server started on http://localhost:${port}`, "info");
					ctx.ui.notify(`Agent card: http://localhost:${port}${AGENT_CARD_PATH}`, "info");
				} catch (error: unknown) {
					ctx.ui.notify(`Failed to start A2A server: ${errorMessage(error)}`, "error");
					serverState = null;
				}
				return;
			}

			if (subcmd === "stop" || subcmd === "off") {
				if (!serverState) {
					ctx.ui.notify("A2A server is not running", "warning");
					return;
				}
				await new Promise<void>((resolve) => {
					serverState!.server.close(() => resolve());
				});
				ctx.ui.notify(`A2A server stopped (was on port ${serverState.port})`, "info");
				serverState = null;
				return;
			}

			if (subcmd === "discover") {
				const url = parts[1];
				if (!url) {
					ctx.ui.notify("Usage: /a2a discover <agent-url>", "warning");
					return;
				}
				try {
					ctx.ui.notify(`Discovering A2A agent at ${url}...`, "info");
					const signal = AbortSignal.timeout(15_000);
					const client = await createA2AClient(url, signal);
					const card = await client.getAgentCard({ signal });
					ctx.ui.notify(`Agent: ${card.name} (v${card.version ?? "?"})`, "info");
					ctx.ui.notify(`Description: ${card.description ?? "(none)"}`, "info");
					ctx.ui.notify(`Skills: ${card.skills?.map((s) => s.name).join(", ") ?? "(none)"}`, "info");
					ctx.ui.notify(`Streaming: ${card.capabilities?.streaming ? "yes" : "no"}`, "info");
				} catch (error: unknown) {
					ctx.ui.notify(`Discovery failed: ${errorMessage(error)}`, "error");
				}
				return;
			}

			// status (default)
			if (serverState) {
				ctx.ui.notify(`A2A server: RUNNING on http://localhost:${serverState.port}`, "info");
				ctx.ui.notify(`Agent card: http://localhost:${serverState.port}${AGENT_CARD_PATH}`, "info");
			} else {
				ctx.ui.notify("A2A server: STOPPED. Use /a2a start [port] to start.", "info");
			}
			ctx.ui.notify("Registered tools: a2a_delegate, a2a_discover", "info");
		},
	});

	// ---- Lifecycle ----
	pi.on("session_start", async (_event, ctx) => {
		currentRuntime = ctx.model ? { model: ctx.model, modelRegistry: ctx.modelRegistry } : null;
	});

	pi.on("model_select", async (event, ctx) => {
		currentRuntime = { model: event.model, modelRegistry: ctx.modelRegistry };
	});

	pi.on("session_shutdown", async () => {
		if (serverState) {
			await new Promise<void>((resolve) => {
				serverState!.server.close(() => resolve());
			});
			serverState = null;
		}
		currentRuntime = null;
	});
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

async function startServer(getModel: () => A2ARuntime | null, port: number): Promise<A2AServerState> {
	const agentCard = createPiAgentCard(port);
	const taskStore = new InMemoryTaskStore();
	const executor = new PiA2AExecutor(getModel);
	const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

	const app = express();
	app.use(express.json({ limit: "10mb" }));
	app.use(`/${AGENT_CARD_PATH.replace(/^\//, "")}`, agentCardHandler({ agentCardProvider: requestHandler }));
	app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

	const server = app.listen(port, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});

	return { app, server, port };
}
