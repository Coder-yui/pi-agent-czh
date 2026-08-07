/**
 * PiAcpAgent — the core ACP agent implementation for pi.
 *
 * This module is side-effect-free: importing it does NOT start any server.
 * Use `createPiAcpAgent()` to get a configured `AgentApp`, or run `index.ts`
 * for the stdio entry point spawned by editors.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORE_DIR = resolve(__dirname, "../../../src/core");

const DefaultResourceLoader = (await import(join(CORE_DIR, "resource-loader.ts"))).DefaultResourceLoader;
const { createAgentSession } = await import(join(CORE_DIR, "sdk.ts"));
const { SessionManager } = await import(join(CORE_DIR, "session-manager.ts"));
const { SettingsManager } = await import(join(CORE_DIR, "settings-manager.ts"));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AcpSessionState {
	acpSessionId: string;
	cwd: string;
	agentDir: string;
	session: any;
	unsubscribe: () => void;
	abortController: AbortController;
}

export interface PiAcpAgentOptions {
	/** Optional override for createAgentSession options (used by tests to inject faux model, etc.). */
	createSessionOverrides?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class PiAcpAgent {
	private sessions = new Map<string, AcpSessionState>();
	private opts: PiAcpAgentOptions;

	constructor(opts: PiAcpAgentOptions = {}) {
		this.opts = opts;
	}

	async initialize(_params: any) {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			serverInfo: { name: "pi-coding-agent", version: "0.1.0" },
			agentCapabilities: { loadSession: false },
		};
	}

	async authenticate(_params: any) {
		return {};
	}

	async setSessionMode(_params: any) {
		return {};
	}

	async newSession(params: any) {
		const cwd: string = params?.cwd ? resolve(params.cwd) : process.cwd();
		mkdirSync(cwd, { recursive: true });

		const acpSessionId = randomUUID();
		const sessionsRoot = join(tmpdir(), "pi-acp", "sessions");
		const agentDir = join(sessionsRoot, acpSessionId);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });

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
			mode: "acp",
			...(this.opts.createSessionOverrides ?? {}),
		});

		await session.bindExtensions({ mode: "rpc" });

		const state: AcpSessionState = {
			acpSessionId,
			cwd,
			agentDir,
			session,
			unsubscribe: () => {},
			abortController: new AbortController(),
		};
		this.sessions.set(acpSessionId, state);

		return { sessionId: acpSessionId, meta: { cwd, agentDir } };
	}

	async cancel(params: any) {
		const state = this.sessions.get(params?.sessionId);
		if (!state) return;
		state.abortController.abort();
		try { await state.session.abort?.(); } catch { /* ignore */ }
	}

	async closeSession(params: any) {
		const state = this.sessions.get(params?.sessionId);
		if (!state) return {};
		state.unsubscribe();
		state.abortController.abort();
		try { state.session.dispose?.(); } catch { /* ignore */ }
		this.sessions.delete(params.sessionId);
		return {};
	}

	async prompt(params: any, cx: { client: acp.AgentContext; signal: AbortSignal }) {
		const state = this.sessions.get(params?.sessionId);
		if (!state) throw new Error(`Session ${params?.sessionId} not found`);

		state.abortController = new AbortController();
		const turnSignal = state.abortController.signal;
		const cancelOnClientAbort = () => state.abortController.abort();
		cx.signal.addEventListener("abort", cancelOnClientAbort);

		const contentBlocks: any[] = Array.isArray(params?.content) ? params.content : [];
		const userText = contentBlocks
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n\n");
		const message = userText || "(empty prompt)";

		// Stream pi events → ACP session/update notifications.
		let toolSeq = 0;
		const activeTools: string[] = [];
		let textBuffer = "";
		let flushTimer: NodeJS.Timeout | null = null;

		const flushBuffer = async () => {
			flushTimer = null;
			if (!textBuffer) return;
			const chunk = textBuffer;
			textBuffer = "";
			await cx.client.notify(acp.methods.client.session.update, {
				sessionId: state.acpSessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: chunk },
				},
			});
		};
		const bufferChunk = (text: string) => {
			textBuffer += text;
			if (!flushTimer) flushTimer = setTimeout(() => void flushBuffer(), 50);
		};

		state.unsubscribe();
		state.unsubscribe = state.session.subscribe((event: any) => {
			if (turnSignal.aborted) return;
			try {
				switch (event.type) {
					case "message_update": {
						const ame = event.assistantMessageEvent;
						if (!ame) break;
						if (typeof ame.delta === "string") bufferChunk(ame.delta);
						break;
					}
					case "tool_execution_start": {
						toolSeq += 1;
						const toolCallId = `tc_${toolSeq}`;
						activeTools.push(toolCallId);
						void cx.client.notify(acp.methods.client.session.update, {
							sessionId: state.acpSessionId,
							update: {
								sessionUpdate: "tool_call",
								toolCallId,
								title: event.toolName,
								kind: guessToolKind(event.toolName),
								status: "pending",
							},
						});
						break;
					}
					case "tool_execution_update": {
						const lastId = activeTools[activeTools.length - 1];
						if (!lastId) break;
						const out = event.delta ?? event.output ?? "";
						if (typeof out === "string" && out.length > 0) {
							void cx.client.notify(acp.methods.client.session.update, {
								sessionId: state.acpSessionId,
								update: {
									sessionUpdate: "tool_call_update",
									toolCallId: lastId,
									status: "running",
									content: [{ type: "content", content: { type: "text", text: out.slice(-2000) } }],
								},
							});
						}
						break;
					}
					case "tool_execution_end": {
						const lastId = activeTools.pop();
						if (!lastId) break;
						void cx.client.notify(acp.methods.client.session.update, {
							sessionId: state.acpSessionId,
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId: lastId,
								status: event.error ? "error" : "completed",
								rawOutput: event.error ? { error: String(event.error) } : { ok: true },
							},
						});
						break;
					}
				}
			} catch (e) {
				// Don't let streaming errors crash the turn.
				console.error("[pi-acp] event handling error:", e);
			}
		});

		try {
			await state.session.prompt(message, { source: "acp" });
			await flushBuffer();
			cx.signal.removeEventListener("abort", cancelOnClientAbort);
			return { stopReason: turnSignal.aborted ? "cancelled" : "end_turn" as const };
		} catch (err: any) {
			await flushBuffer();
			cx.signal.removeEventListener("abort", cancelOnClientAbort);
			if (turnSignal.aborted) return { stopReason: "cancelled" as const };
			await cx.client.notify(acp.methods.client.session.update, {
				sessionId: state.acpSessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `\n\n[pi error] ${err?.message ?? String(err)}` },
				},
			});
			return { stopReason: "end_turn" as const };
		}
	}
}

function guessToolKind(toolName: string): string {
	if (!toolName) return "tool";
	const n = toolName.toLowerCase();
	if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "terminal";
	if (n.includes("read") || n.includes("grep") || n.includes("find") || n.includes("list")) return "read";
	if (n.includes("write") || n.includes("edit") || n.includes("replace") || n.includes("create")) return "edit";
	if (n.includes("delete") || n.includes("rm")) return "delete";
	return "tool";
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
