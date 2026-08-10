import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildAgentApp, PiAcpAgent } from "../lib.ts";

const provider = process.env.PI_PROVIDER?.trim() || "deepseek";
const modelId = process.env.PI_MODEL?.trim() || "deepseek-v4-pro";
const root = process.env.PI_LIVE_TEST_ROOT;
if (!root) throw new Error("PI_LIVE_TEST_ROOT is required");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

class LiveAcpClient {
	readonly notifications: acp.SessionUpdate[] = [];

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		this.notifications.push(params.update);
	}

	async requestPermission(): Promise<acp.RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async writeTextFile(): Promise<acp.WriteTextFileResponse> {
		return {};
	}

	async readTextFile(): Promise<acp.ReadTextFileResponse> {
		return { content: "" };
	}
}

const cwd = join(root, "acp", "workspace");
const agentDir = join(root, "acp", "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);

const piAgent = new PiAcpAgent({ agentDir, createSessionOverrides: { model, modelRuntime, thinkingLevel: "off" } });
const agentApp = buildAgentApp(piAgent);
const client = new LiveAcpClient();
const clientApp = acp
	.client({ name: "pi-live-acp" })
	.onNotification(acp.methods.client.session.update, (ctx) => client.sessionUpdate(ctx.params))
	.onRequest(acp.methods.client.session.requestPermission, () => client.requestPermission())
	.onRequest(acp.methods.client.fs.writeTextFile, () => client.writeTextFile())
	.onRequest(acp.methods.client.fs.readTextFile, () => client.readTextFile());

await clientApp.connectWith(agentApp, async (connection) => {
	const initialized = await connection.request(acp.methods.agent.initialize, {
		protocolVersion: acp.PROTOCOL_VERSION,
		clientInfo: { name: "pi-live-acp", version: "1.0.0" },
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
	});
	assert(initialized.protocolVersion === acp.PROTOCOL_VERSION, "ACP protocol negotiation failed");
	let sessionId = "";
	await connection.buildSession(cwd).withSession(async (session) => {
		sessionId = session.sessionId;
		session.prompt([{ type: "text", text: "Reply with exactly ACP_LIVE_OK and no other text." }]);
		for (;;) {
			const update = await session.nextUpdate();
			if (update.kind === "stop") {
				assert(update.response.stopReason === "end_turn", `ACP stopped as ${update.response.stopReason}`);
				break;
			}
		}
	});
	assert(sessionId, "ACP did not create a session");
	await connection.request(acp.methods.agent.session.close, { sessionId });
});

const chunks = client.notifications.filter(
	(update): update is Extract<acp.SessionUpdate, { sessionUpdate: "agent_message_chunk" }> =>
		update.sessionUpdate === "agent_message_chunk",
);
const streamedText = chunks.map((chunk) => (chunk.content.type === "text" ? chunk.content.text : "")).join("");
assert(chunks.length > 0, "ACP did not emit agent_message_chunk notifications");
assert(streamedText.includes("ACP_LIVE_OK"), `ACP streamed unexpected text: ${streamedText}`);
console.log("  PASS ACP streamed a real DeepSeek response and closed the session");
