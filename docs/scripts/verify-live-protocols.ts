import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import a2aExtension from "../../packages/coding-agent/examples/extensions/a2a/index.ts";
import agentLoopExtension from "../../packages/coding-agent/examples/extensions/agent-loop/index.ts";

const provider = process.env.PI_PROVIDER?.trim() || "deepseek";
const modelId = process.env.PI_MODEL?.trim() || "deepseek-v4-pro";
const root = process.env.PI_LIVE_TEST_ROOT;
if (!root) throw new Error("PI_LIVE_TEST_ROOT is required");

mkdirSync(root, { recursive: true });
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function createLiveSession(name: string, extensionFactories: ExtensionFactory[]): Promise<AgentSession> {
	const cwd = join(root, name, "workspace");
	const agentDir = join(root, name, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
		resourceLoader,
		thinkingLevel: "off",
	});
	await session.bindExtensions({});
	return session;
}

async function shutdown(session: AgentSession): Promise<void> {
	await session.shutdownExtensions("quit");
	session.dispose();
}

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "Could not allocate A2A test port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

async function testAgentLoop(): Promise<void> {
	const session = await createLiveSession("loop", [agentLoopExtension]);
	try {
		session.setActiveToolsByName(["agent_loop_checkpoint"]);
		await session.prompt(
			"/agent-loop start This is a protocol test. On iteration 1 checkpoint continue; on iteration 2 checkpoint complete. Use non-empty summary and evidence. --max-iterations=2 --max-tools=1 --timeout-minutes=3",
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await session.waitForIdle();
		const stateEntry = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "agent-loop-state")
			.at(-1);
		assert(stateEntry?.type === "custom" && typeof stateEntry.data === "object" && stateEntry.data !== null, "Agent Loop did not persist state");
		const state = stateEntry.data as { status?: string; iteration?: number; checkpoints?: unknown[] };
		assert(state.status === "completed", `Agent Loop ended as ${state.status ?? "unknown"}`);
		assert(state.iteration === 2 && state.checkpoints?.length === 2, "Agent Loop did not execute two live iterations");
		console.log("  PASS Agent Loop completed two real DeepSeek iterations");
	} finally {
		await shutdown(session);
	}
}

async function testA2A(): Promise<void> {
	const session = await createLiveSession("a2a", [a2aExtension]);
	const port = await availablePort();
	try {
		await session.prompt(`/a2a start ${port}`);
		const tool = session.agent.state.tools.find((candidate) => candidate.name === "a2a_delegate");
		assert(tool, "a2a_delegate was not registered");
		const result = await tool.execute(
			"live-a2a",
			{
				agent_url: `http://127.0.0.1:${port}`,
				task: "Reply with exactly A2A_LIVE_OK and no other text.",
			},
			AbortSignal.timeout(120_000),
		);
		assert(!result.isError, resultText(result));
		assert(resultText(result).includes("A2A_LIVE_OK"), "A2A round trip did not return the live model marker");
		console.log("  PASS A2A delegated through the protocol to real DeepSeek");
		await session.prompt("/a2a stop");
	} finally {
		await shutdown(session);
	}
}

try {
	await testAgentLoop();
	await testA2A();
} finally {
	rmSync(root, { recursive: true, force: true });
}
