/**
 * End-to-end test for pi-acp adapter.
 *
 * Tests the ACP protocol bridging layer end-to-end without requiring a real LLM API key:
 *  1. Uses the official @agentclientprotocol/sdk client in-process (App-to-App, no stdio/spawn).
 *  2. Verifies the initialize handshake (protocol version + server info negotiation).
 *  3. Verifies session/new via buildSession().withSession() creates an isolated pi session.
 *  4. Verifies session/prompt is forwarded into the pi session and events stream back via
 *     session/update notifications.
 *  5. Verifies stopReason is correctly reported.
 *  6. Verifies session cleanup on close.
 *
 * A deterministic faux provider emits two parallel tool calls followed by a successful
 * assistant reply, so the test needs no API key or network access.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { PiAcpAgent, buildAgentApp } = await import(join(__dirname, "..", "lib.ts"));

const notifications: acp.SessionUpdate[] = [];
const permissionRequests: acp.RequestPermissionRequest[] = [];
class TestClient {
	async sessionUpdate(params: acp.SessionNotification) {
		notifications.push(params.update);
	}
	async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		permissionRequests.push(params);
		return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
	}
	async writeTextFile(): Promise<acp.WriteTextFileResponse> {
		return {};
	}
	async readTextFile(): Promise<acp.ReadTextFileResponse> {
		return { content: "mock file" };
	}
}

async function main() {
	const tempDir = join(tmpdir(), `pi-acp-e2e-${Date.now()}`);
	const cwd = tempDir;
	const agentDir = join(tempDir, "agent");
	const shutdownMarker = join(tempDir, "shutdown-marker");
	const extensionsDir = join(agentDir, "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(
		join(extensionsDir, "acp-lifecycle-probe.ts"),
		`import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_agent_start", async (_event, ctx) => {
    const allowed = await ctx.ui.confirm("ACP permission bridge", "Allow the test prompt?");
    if (!allowed) throw new Error("permission rejected");
  });
  pi.on("session_shutdown", async () => {
    writeFileSync(${JSON.stringify(shutdownMarker)}, "shutdown");
  });
}
`,
	);

	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("bash", { command: "printf first" }, { id: "parallel-1" }),
				fauxToolCall("bash", { command: "printf second" }, { id: "parallel-2" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Hello from pi over ACP"),
	]);
	const modelRuntime = await ModelRuntime.create();
	modelRuntime.registerNativeProvider(faux.provider);
	const piAgent = new PiAcpAgent({
		agentDir,
		createSessionOverrides: { model: faux.getModel(), modelRuntime },
	});
	const agentApp = buildAgentApp(piAgent);

	const client = new TestClient();
	const clientApp = acp
		.client({ name: "pi-acp-e2e" })
		.onNotification(acp.methods.client.session.update, (ctx) => client.sessionUpdate(ctx.params))
		.onRequest(acp.methods.client.session.requestPermission, (ctx) => client.requestPermission(ctx.params))
		.onRequest(acp.methods.client.fs.writeTextFile, () => client.writeTextFile())
		.onRequest(acp.methods.client.fs.readTextFile, () => client.readTextFile());

	let stopReason: string | undefined;
	let observedSessionId: string | undefined;

	const result = await clientApp.connectWith(agentApp, async (cx) => {
		// 1. initialize handshake
		const initRes = await cx.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientInfo: { name: "pi-acp-e2e", version: "0.1.0" },
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
		});
		console.log(`[1] ✅ initialize: ${initRes.agentInfo?.name} v${initRes.agentInfo?.version}`);
		if (initRes.protocolVersion !== acp.PROTOCOL_VERSION) {
			throw new Error(`protocol mismatch: got ${initRes.protocolVersion}, want ${acp.PROTOCOL_VERSION}`);
		}

		// 2-5. buildSession handles session/new; withSession handles lifecycle + close.
		const response = await cx.buildSession(cwd).withSession(async (session) => {
			observedSessionId = session.sessionId;
			console.log(`[2] ✅ session/new: sessionId=${observedSessionId}`);
			if (!observedSessionId) throw new Error("no sessionId from buildSession");

			console.log(`[3] 📤 sending prompt...`);
			session.prompt([{ type: "text", text: "Hello, pi!" }]);

			// Drain notifications until the turn stops.
			let response: acp.PromptResponse | undefined;
			for (;;) {
				const message = await session.nextUpdate();
				if (message.kind === "stop") {
					response = message.response;
					break;
				}
				// Notifications are already routed through clientApp's registered handler.
			}
			if (!response) throw new Error("prompt stopped without a response");
			stopReason = response.stopReason;
			console.log(`[4] ✅ prompt complete: stopReason=${stopReason}`);
			return response;
		});
		if (!observedSessionId) throw new Error("session ID missing before close");
		await cx.request(acp.methods.agent.session.close, { sessionId: observedSessionId });
		return response;
	});

	stopReason = result.stopReason;

	// Assertions --------------------------------------------------------------

	const chunks = notifications.filter(
		(update): update is Extract<acp.SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
			update.sessionUpdate === "agent_message_chunk",
	);
	const toolCalls = notifications.filter(
		(update): update is Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" }> =>
			update.sessionUpdate === "tool_call",
	);
	console.log(`\n[assert] notifications: ${notifications.length} total`);
	console.log(`[assert]   - agent_message_chunk: ${chunks.length}`);
	console.log(`[assert]   - tool_call:           ${toolCalls.length}`);

	if (stopReason !== "end_turn") {
		throw new Error(`expected stopReason=end_turn, got ${stopReason}`);
	}
	if (!observedSessionId) {
		throw new Error("sessionId was not assigned");
	}
	if (permissionRequests.length !== 1 || permissionRequests[0]?.options[0]?.kind !== "allow_once") {
		throw new Error(`expected one ACP permission request, got: ${JSON.stringify(permissionRequests)}`);
	}
	if (!existsSync(shutdownMarker)) {
		throw new Error("session/close did not emit session_shutdown before disposal");
	}
	if (chunks.length === 0) {
		throw new Error("expected at least one agent_message_chunk through the ACP channel — event bridging broken");
	}

	const fullText = chunks.map((chunk) => (chunk.content.type === "text" ? chunk.content.text : "")).join("");
	console.log(`[assert] streamed text (first 200 chars):\n    ${fullText.slice(0, 200).replace(/\n/g, "\n    ")}`);
	if (fullText.length === 0) {
		throw new Error("streamed chunks contained no text");
	}
	if (!fullText.includes("Hello from pi over ACP")) {
		throw new Error(`expected faux model response over ACP, got: ${fullText}`);
	}
	if (toolCalls.length !== 2 || new Set(toolCalls.map((call) => call.toolCallId)).size !== 2) {
		throw new Error(`expected two distinct parallel tool-call IDs, got: ${JSON.stringify(toolCalls)}`);
	}
	const completedToolIds = new Set(
		notifications
			.filter(
				(update): update is Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }> =>
					update.sessionUpdate === "tool_call_update" && update.status === "completed",
			)
			.map((update) => update.toolCallId),
	);
	if (!toolCalls.every((call) => completedToolIds.has(call.toolCallId))) {
		throw new Error(`expected completion updates for both tool calls, got: ${JSON.stringify(notifications)}`);
	}

	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	console.log("\n[passed] ✅ pi-acp adapter e2e test passed");
	console.log("\n  Note: This test exercises the full ACP protocol lifecycle with pi");
	console.log("  (init → session/new → prompt → streaming updates → stop → close).");
	console.log("  The test uses pi's faux provider, so no external API key is required.");
}

main().catch((error: unknown) => {
	console.error("\n[failed]", error instanceof Error ? error.stack : error);
	process.exit(1);
});
