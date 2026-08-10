import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type GraphNodeExecutor, runAgentGraph } from "../engine.ts";
import { createAgentGraphExtension } from "../index.ts";
import { extractAssistantText, resolveNodeCwd } from "../process-node.ts";
import { parseAgentGraphDefinition } from "../schema.ts";

let passed = 0;

function assert(condition: unknown, label: string): void {
	if (!condition) throw new Error(`Assertion failed: ${label}`);
	passed += 1;
	console.log(`  PASS ${label}`);
}

const cyclicDefinition = parseAgentGraphDefinition({
	version: 1,
	name: "review-cycle",
	description: "Exercise conditional routing and a bounded correction cycle",
	entrypoint: "draft",
	maxSteps: 10,
	nodes: [
		{ id: "draft", type: "agent", task: "Draft {{input}} after {{outputs.review}}", maxVisits: 2 },
		{ id: "review", type: "agent", task: "Review {{outputs.draft}}", maxVisits: 2 },
		{ id: "finish", type: "agent", task: "Finish from {{last_output}}" },
	],
	edges: [
		{ from: "draft", to: "review", when: "always" },
		{ from: "review", to: "draft", when: "output_contains", contains: "retry" },
		{ from: "review", to: "finish", when: "output_contains", contains: "approved" },
		{ from: "review", to: "__end__", when: "always" },
		{ from: "finish", to: "__end__", when: "always" },
	],
});

function deterministicExecutor(): GraphNodeExecutor {
	return async (node, context) => {
		let output: string;
		if (node.id === "draft") output = `draft-${context.visit}:${context.task}`;
		else if (node.id === "review") output = context.visit === 1 ? "retry with changes" : "approved";
		else output = `final:${context.task}`;
		return {
			nodeId: node.id,
			nodeType: node.type,
			status: "success",
			output,
			startedAt: Date.now(),
			completedAt: Date.now(),
		};
	};
}

async function main(): Promise<void> {
	const direct = await runAgentGraph(cyclicDefinition, "feature-x", deterministicExecutor());
	assert(direct.status === "completed", "LangGraph StateGraph completes a conditional cycle");
	assert(
		direct.trace.map((entry) => entry.nodeId).join(",") === "draft,review,draft,review,finish",
		"conditional edges route through correction and approval branches",
	);
	assert(direct.visits.draft === 2 && direct.visits.review === 2, "node visits are accumulated in graph state");
	assert(direct.output.startsWith("final:Finish from approved"), "node templates consume prior graph outputs");
	assert(
		resolveNodeCwd("/tmp/project", "packages/app") === "/tmp/project/packages/app",
		"node cwd resolves inside root",
	);
	let cwdEscapeRejected = false;
	try {
		resolveNodeCwd("/tmp/project", "../outside");
	} catch {
		cwdEscapeRejected = true;
	}
	assert(cwdEscapeRejected, "node cwd cannot escape the project root");
	assert(
		extractAssistantText({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "node output" }], stopReason: "stop" },
		}).text === "node output",
		"pi JSON event parser extracts node output",
	);

	const approvalDefinition = parseAgentGraphDefinition({
		version: 1,
		name: "approval-route",
		entrypoint: "approve",
		maxSteps: 4,
		nodes: [
			{ id: "approve", type: "approval", title: "Approve", message: "Approve {{input}}?" },
			{ id: "accepted", type: "agent", task: "Accepted {{input}}" },
		],
		edges: [
			{ from: "approve", to: "accepted", when: "approved" },
			{ from: "approve", to: "__end__", when: "always" },
			{ from: "accepted", to: "__end__", when: "always" },
		],
	});
	const approvalExecutor: GraphNodeExecutor = async (node) => ({
		nodeId: node.id,
		nodeType: node.type,
		status: node.type === "approval" ? "approved" : "success",
		output: node.type === "approval" ? "approved" : "accepted",
		startedAt: Date.now(),
		completedAt: Date.now(),
	});
	const approved = await runAgentGraph(approvalDefinition, "release", approvalExecutor);
	assert(approved.trace.map((entry) => entry.nodeId).join(",") === "approve,accepted", "approval status routes edges");

	let invalidRejected = false;
	try {
		parseAgentGraphDefinition({
			version: 1,
			name: "invalid",
			entrypoint: "missing",
			nodes: [{ id: "only", type: "agent", task: "x" }],
			edges: [],
		});
	} catch {
		invalidRejected = true;
	}
	assert(invalidRejected, "schema validation rejects missing entrypoints and unreachable nodes");

	const endless = parseAgentGraphDefinition({
		version: 1,
		name: "endless",
		entrypoint: "cycle",
		maxSteps: 3,
		nodes: [{ id: "cycle", type: "agent", task: "again" }],
		edges: [{ from: "cycle", to: "cycle", when: "always" }],
	});
	const exhausted = await runAgentGraph(endless, "x", deterministicExecutor());
	assert(exhausted.status === "exhausted", "LangGraph recursion limit stops unbounded cycles");

	const controller = new AbortController();
	const waitForAbort: GraphNodeExecutor = async (node, context) => {
		await new Promise<void>((_resolve, reject) => {
			context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
		return {
			nodeId: node.id,
			nodeType: node.type,
			status: "success",
			output: "unexpected",
			startedAt: Date.now(),
			completedAt: Date.now(),
		};
	};
	const canceledPromise = runAgentGraph(cyclicDefinition, "cancel", waitForAbort, { signal: controller.signal });
	setTimeout(() => controller.abort(new Error("test cancellation")), 0);
	const canceled = await canceledPromise;
	assert(canceled.status === "canceled", "AbortSignal cancels a running graph node");

	const temporaryDirectory = join(tmpdir(), `pi-agent-graph-${Date.now()}`);
	const agentDirectory = join(temporaryDirectory, "agent");
	const graphDirectory = join(temporaryDirectory, ".pi", "agent-graphs");
	mkdirSync(agentDirectory, { recursive: true });
	mkdirSync(graphDirectory, { recursive: true });
	writeFileSync(join(graphDirectory, "review-cycle.json"), JSON.stringify(cyclicDefinition), "utf8");
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create();
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.create(temporaryDirectory, agentDirectory);
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: temporaryDirectory,
		agentDir: agentDirectory,
		settingsManager,
		extensionFactories: [
			createAgentGraphExtension({ nodeExecutor: deterministicExecutor(), confirmProjectGraphs: false }),
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: temporaryDirectory,
		agentDir: agentDirectory,
		model: faux.getModel(),
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
	});
	await session.bindExtensions({});
	const graphTool = session.agent.state.tools.find((tool) => tool.name === "agent_graph_run");
	assert(graphTool !== undefined, "Agent Graph tool is registered in a real AgentSession");
	if (!graphTool) throw new Error("Agent Graph tool missing");
	const toolResult = await graphTool.execute("graph-call", {
		graph: "review-cycle",
		input: "feature-x",
	});
	assert(
		toolResult.content.some((part) => part.type === "text" && part.text.includes("review-cycle: completed")),
		"project graph executes through the real extension tool adapter",
	);
	assert(
		toolResult.content.some((part) => part.type === "text" && part.text.includes("draft#1:success")),
		"tool result exposes the executed route",
	);
	assert(
		sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "agent-graph-run"),
		"graph run summary is persisted in the pi session",
	);

	await session.shutdownExtensions("quit");
	session.dispose();
	rmSync(temporaryDirectory, { recursive: true, force: true });
	console.log(`\nResults: ${passed} passed, 0 failed`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
