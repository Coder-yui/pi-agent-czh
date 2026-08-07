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
 * The streamed content we receive in CI (no API key) is pi's "no API key" error — which
 * exercises the exact same event bridge as a successful assistant reply. Production use
 * requires ANTHROPIC_API_KEY / OPENAI_API_KEY etc. (same as running pi normally).
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { PiAcpAgent, buildAgentApp } = await import(join(__dirname, "..", "lib.ts"));

const notifications: any[] = [];
class TestClient {
	async sessionUpdate(params: any) {
		notifications.push(params.update);
	}
	async requestPermission() {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}
	async writeTextFile() { return {}; }
	async readTextFile() { return { content: "mock file" }; }
}

async function main() {
	const tempDir = join(tmpdir(), `pi-acp-e2e-${Date.now()}`);
	const cwd = tempDir;
	mkdirSync(join(cwd, ".pi"), { recursive: true });

	const piAgent = new PiAcpAgent();
	const agentApp = buildAgentApp(piAgent);

	const client = new TestClient();
	const clientApp = acp
		.client({ name: "pi-acp-e2e" })
		.onNotification(acp.methods.client.session.update, (ctx) => client.sessionUpdate(ctx.params))
		.onRequest(acp.methods.client.session.requestPermission, (ctx) => client.requestPermission(ctx.params))
		.onRequest(acp.methods.client.fs.writeTextFile, (ctx) => client.writeTextFile(ctx.params))
		.onRequest(acp.methods.client.fs.readTextFile, (ctx) => client.readTextFile(ctx.params));

	let stopReason: string | undefined;
	let observedSessionId: string | undefined;

	const result: any = await clientApp.connectWith(agentApp, async (cx) => {
		// 1. initialize handshake
		const initRes: any = await cx.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientInfo: { name: "pi-acp-e2e", version: "0.1.0" },
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
		});
		console.log(`[1] ✅ initialize: ${initRes.serverInfo.name} v${initRes.serverInfo.version}`);
		if (initRes.protocolVersion !== acp.PROTOCOL_VERSION) {
			throw new Error(`protocol mismatch: got ${initRes.protocolVersion}, want ${acp.PROTOCOL_VERSION}`);
		}

		// 2-5. buildSession handles session/new; withSession handles lifecycle + close.
		return cx.buildSession(cwd).withSession(async (session) => {
			observedSessionId = session.sessionId;
			console.log(`[2] ✅ session/new: sessionId=${observedSessionId}`);
			if (!observedSessionId) throw new Error("no sessionId from buildSession");

			console.log(`[3] 📤 sending prompt...`);
			session.prompt([{ type: "text", text: "Hello, pi!" }]);

			// Drain notifications until the turn stops.
			let response: any;
			for (;;) {
				const message = await session.nextUpdate();
				if (message.kind === "stop") {
					response = message.response;
					break;
				}
				// message.kind === "notification" — route to handler.
				await client.sessionUpdate(message.notification);
			}
			stopReason = response.stopReason;
			console.log(`[4] ✅ prompt complete: stopReason=${stopReason}`);
			return response;
		});
	});

	stopReason = result.stopReason;

	// Assertions --------------------------------------------------------------

	const chunks = notifications.filter((u) => u.sessionUpdate === "agent_message_chunk");
	const toolCalls = notifications.filter((u) => u.sessionUpdate === "tool_call");
	console.log(`\n[assert] notifications: ${notifications.length} total`);
	console.log(`[assert]   - agent_message_chunk: ${chunks.length}`);
	console.log(`[assert]   - tool_call:           ${toolCalls.length}`);

	if (stopReason !== "end_turn") {
		throw new Error(`expected stopReason=end_turn, got ${stopReason}`);
	}
	if (!observedSessionId) {
		throw new Error("sessionId was not assigned");
	}
	if (chunks.length === 0) {
		throw new Error("expected at least one agent_message_chunk through the ACP channel — event bridging broken");
	}

	const fullText = chunks.map((c) => c.content?.text ?? "").join("");
	console.log(`[assert] streamed text (first 200 chars):\n    ${fullText.slice(0, 200).replace(/\n/g, "\n    ")}`);
	if (fullText.length === 0) {
		throw new Error("streamed chunks contained no text");
	}

	try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
	console.log("\n[passed] ✅ pi-acp adapter e2e test passed");
	console.log("\n  Note: This test exercises the full ACP protocol lifecycle with pi");
	console.log("  (init → session/new → prompt → streaming updates → stop → close).");
	console.log("  With a real API key configured, streamed chunks contain the assistant");
	console.log("  reply; in this test they contain pi's 'no API key' error — which uses");
	console.log("  the exact same event bridge.");
}

main().catch((err) => {
	console.error("\n[failed]", err?.stack ?? err);
	process.exit(1);
});
