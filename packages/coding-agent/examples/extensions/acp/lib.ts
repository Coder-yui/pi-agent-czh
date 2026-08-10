/**
 * PiAcpAgent — the core ACP agent implementation for pi.
 *
 * This module is side-effect-free: importing it does NOT start any server.
 * Use `createPiAcpAgent()` to get a configured `AgentApp`, or run `index.ts`
 * for the stdio entry point spawned by editors.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AcpSessionState {
	acpSessionId: string;
	cwd: string;
	agentDir: string;
	session: AgentSession;
	unsubscribe: () => void;
	abortController: AbortController;
	activeClient?: acp.AgentContext;
	notificationQueue: Promise<void>;
}

export interface PiAcpAgentOptions {
	/** Optional override for createAgentSession options (used by tests to inject faux model, etc.). */
	createSessionOverrides?: Record<string, unknown>;
	/** Use pi's configured agent directory by default; tests may provide an isolated directory. */
	agentDir?: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class PiAcpAgent {
	private readonly sessions = new Map<string, AcpSessionState>();
	private readonly opts: PiAcpAgentOptions;

	constructor(opts: PiAcpAgentOptions = {}) {
		this.opts = opts;
	}

	async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentInfo: { name: "pi-coding-agent", version: "0.1.0" },
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { embeddedContext: true },
				sessionCapabilities: { close: {} },
			},
		};
	}

	async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		return {};
	}

	async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
		return {};
	}

	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		if (params.mcpServers.length > 0) {
			throw new Error("This ACP adapter does not yet support client-provided MCP servers");
		}
		if (params.additionalDirectories && params.additionalDirectories.length > 0) {
			throw new Error("This ACP adapter does not advertise additional workspace directory support");
		}
		const cwd = resolve(params.cwd);
		mkdirSync(cwd, { recursive: true });

		const acpSessionId = randomUUID();
		const agentDir = this.opts.agentDir ?? getAgentDir();
		mkdirSync(agentDir, { recursive: true });

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		// Pass no explicit model — createAgentSession will auto-discover providers
		// from environment / standard config paths via ModelRuntime.create().
		// Tests can inject a faux model via createSessionOverrides.
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			sessionManager,
			resourceLoader,
			...(this.opts.createSessionOverrides ?? {}),
		});

		const state: AcpSessionState = {
			acpSessionId,
			cwd,
			agentDir,
			session,
			unsubscribe: () => {},
			abortController: new AbortController(),
			notificationQueue: Promise.resolve(),
		};
		try {
			await session.bindExtensions({ mode: "rpc", uiContext: createAcpExtensionUIContext(state) });
			this.sessions.set(acpSessionId, state);
		} catch (error: unknown) {
			session.dispose();
			throw error;
		}

		return { sessionId: acpSessionId, _meta: { cwd, agentDir } };
	}

	async cancel(params: acp.CancelNotification): Promise<void> {
		const state = this.sessions.get(params.sessionId);
		if (!state) return;
		state.abortController.abort();
		try {
			await state.session.abort();
		} catch {
			/* ignore */
		}
	}

	async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
		const state = this.sessions.get(params.sessionId);
		if (!state) return {};
		state.unsubscribe();
		state.abortController.abort();
		try {
			await state.session.abort();
		} catch {
			/* ignore */
		}
		try {
			await state.session.shutdownExtensions("quit");
		} finally {
			state.session.dispose();
			this.sessions.delete(params.sessionId);
		}
		return {};
	}

	async prompt(
		params: acp.PromptRequest,
		cx: { client: acp.AgentContext; signal: AbortSignal },
	): Promise<acp.PromptResponse> {
		const state = this.sessions.get(params.sessionId);
		if (!state) throw new Error(`Session ${params.sessionId} not found`);

		state.abortController = new AbortController();
		state.activeClient = cx.client;
		const turnSignal = state.abortController.signal;
		const cancelOnClientAbort = () => state.abortController.abort();
		cx.signal.addEventListener("abort", cancelOnClientAbort);

		const message = renderPrompt(params.prompt) || "(empty prompt)";

		// Stream pi events → ACP session/update notifications.
		const activeTools = new Set<string>();
		let textBuffer = "";
		let flushTimer: NodeJS.Timeout | null = null;

		const flushBuffer = async () => {
			flushTimer = null;
			if (!textBuffer) return;
			const chunk = textBuffer;
			textBuffer = "";
			await enqueueSessionUpdate(state, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: chunk },
			});
		};
		const bufferChunk = (text: string) => {
			textBuffer += text;
			if (!flushTimer) {
				flushTimer = setTimeout(() => {
					void flushBuffer().catch((error: unknown) => {
						console.error("[pi-acp] failed to flush message chunk:", error);
					});
				}, 50);
			}
		};

		state.unsubscribe();
		state.unsubscribe = state.session.subscribe((event: AgentSessionEvent) => {
			if (turnSignal.aborted) return;
			try {
				switch (event.type) {
					case "message_update": {
						const ame = event.assistantMessageEvent;
						if (ame.type === "text_delta") bufferChunk(ame.delta);
						break;
					}
					case "tool_execution_start": {
						const toolCallId = String(event.toolCallId);
						activeTools.add(toolCallId);
						void enqueueSessionUpdate(state, {
							sessionUpdate: "tool_call",
							toolCallId,
							title: event.toolName,
							kind: guessToolKind(event.toolName),
							status: "pending",
							rawInput: event.args,
						});
						break;
					}
					case "tool_execution_update": {
						const toolCallId = String(event.toolCallId);
						if (!activeTools.has(toolCallId)) break;
						const out = renderToolOutput(event.partialResult);
						if (out.length > 0) {
							void enqueueSessionUpdate(state, {
								sessionUpdate: "tool_call_update",
								toolCallId,
								status: "in_progress",
								content: [{ type: "content", content: { type: "text", text: out.slice(-2000) } }],
							});
						}
						break;
					}
					case "tool_execution_end": {
						const toolCallId = String(event.toolCallId);
						if (!activeTools.delete(toolCallId)) break;
						void enqueueSessionUpdate(state, {
							sessionUpdate: "tool_call_update",
							toolCallId,
							status: event.isError ? "failed" : "completed",
							rawOutput: event.result,
						});
						break;
					}
				}
			} catch (error: unknown) {
				console.error("[pi-acp] event handling error:", error);
			}
		});

		try {
			await state.session.prompt(message, { source: "rpc" });
			await flushBuffer();
			await state.notificationQueue;
			return { stopReason: turnSignal.aborted ? "cancelled" : "end_turn" };
		} catch (error: unknown) {
			await flushBuffer();
			await state.notificationQueue;
			if (turnSignal.aborted) return { stopReason: "cancelled" };
			await enqueueSessionUpdate(state, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `\n\n[pi error] ${errorMessage(error)}` },
			});
			throw error;
		} finally {
			if (flushTimer) clearTimeout(flushTimer);
			cx.signal.removeEventListener("abort", cancelOnClientAbort);
			if (state.activeClient === cx.client) state.activeClient = undefined;
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function renderPrompt(blocks: acp.ContentBlock[]): string {
	return blocks
		.flatMap((block) => {
			if (block.type === "text") return [block.text];
			if (block.type === "resource_link") {
				return [`[Referenced resource: ${block.name} — ${block.uri}]`];
			}
			if (block.type === "resource") {
				return "text" in block.resource
					? [`[Embedded resource: ${block.resource.uri}]\n${block.resource.text}`]
					: [`[Embedded binary resource: ${block.resource.uri} (${block.resource.mimeType ?? "unknown type"})]`];
			}
			return [];
		})
		.join("\n\n");
}

function enqueueSessionUpdate(state: AcpSessionState, update: acp.SessionUpdate): Promise<void> {
	const client = state.activeClient;
	if (!client) return Promise.resolve();
	state.notificationQueue = state.notificationQueue
		.then(() =>
			client.notify(acp.methods.client.session.update, {
				sessionId: state.acpSessionId,
				update,
			}),
		)
		.catch((error: unknown) => {
			console.error("[pi-acp] session/update failed:", error);
		});
	return state.notificationQueue;
}

function createAcpExtensionUIContext(state: AcpSessionState): ExtensionUIContext {
	const supported = {
		async select(): Promise<string | undefined> {
			return undefined;
		},
		async confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
			if (opts?.signal?.aborted) return false;
			const client = state.activeClient;
			if (!client) return false;
			try {
				const response = await client.request(
					acp.methods.client.session.requestPermission,
					{
						sessionId: state.acpSessionId,
						toolCall: {
							toolCallId: `extension-confirm-${randomUUID()}`,
							title,
							kind: "other",
							status: "pending",
							rawInput: { message },
						},
						options: [
							{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
							{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
						],
					},
					opts?.signal ? { cancellationSignal: opts.signal } : undefined,
				);
				return response.outcome.outcome === "selected" && response.outcome.optionId === "allow_once";
			} catch (error: unknown) {
				if (!opts?.signal?.aborted) console.error("[pi-acp] permission request failed:", error);
				return false;
			}
		},
		async input(): Promise<string | undefined> {
			return undefined;
		},
		notify(message: string, type?: "info" | "warning" | "error"): void {
			void enqueueSessionUpdate(state, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `[${type ?? "info"}] ${message}\n` },
			});
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false as const, error: "Theme switching is unavailable over ACP" }),
		getToolsExpanded: () => false,
		getEditorText: () => "",
	} as unknown as ExtensionUIContext;
	return new Proxy(supported, {
		get(target, property, receiver) {
			if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
			if (property === "theme") return undefined;
			return () => undefined;
		},
	});
}

function renderToolOutput(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		return value.content
			.filter((block): block is { type: "text"; text: string } =>
				Boolean(block && typeof block === "object" && block.type === "text" && typeof block.text === "string"),
			)
			.map((block) => block.text)
			.join("\n");
	}
	return value === undefined ? "" : JSON.stringify(value);
}

function guessToolKind(toolName: string): acp.ToolKind {
	if (!toolName) return "other";
	const n = toolName.toLowerCase();
	if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "execute";
	if (n.includes("read") || n.includes("grep") || n.includes("find") || n.includes("list")) return "read";
	if (n.includes("write") || n.includes("edit") || n.includes("replace") || n.includes("create")) return "edit";
	if (n.includes("delete") || n.includes("rm")) return "delete";
	return "other";
}

/**
 * Build a fully-wired ACP AgentApp from a PiAcpAgent instance.
 * Exported for tests and for the stdio entry point.
 */
export function buildAgentApp(agent: PiAcpAgent = new PiAcpAgent()) {
	return acp
		.agent({ name: "pi-acp" })
		.onRequest("initialize", (ctx) => agent.initialize(ctx.params))
		.onRequest("session/new", (ctx) => agent.newSession(ctx.params))
		.onRequest("authenticate", (ctx) => agent.authenticate(ctx.params))
		.onRequest("session/set_mode", (ctx) => agent.setSessionMode(ctx.params))
		.onRequest("session/close", (ctx) => agent.closeSession(ctx.params))
		.onRequest("session/prompt", (ctx) => agent.prompt(ctx.params, ctx))
		.onNotification("session/cancel", (ctx) => agent.cancel(ctx.params));
}
