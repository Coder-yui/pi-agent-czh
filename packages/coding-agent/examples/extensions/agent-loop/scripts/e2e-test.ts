import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import agentLoopExtension, { CHECKPOINT_TOOL, parseStartOptions } from "../index.ts";

let passed = 0;

interface Scenario {
	session: AgentSession;
	sessionManager: SessionManager;
	faux: ReturnType<typeof fauxProvider>;
	cleanup(): Promise<void>;
}

function assert(condition: unknown, label: string): void {
	if (!condition) throw new Error(`Assertion failed: ${label}`);
	passed += 1;
	console.log(`  PASS ${label}`);
}

function finalState(sessionManager: SessionManager): Record<string, unknown> | undefined {
	const entry = sessionManager
		.getEntries()
		.filter((candidate) => candidate.type === "custom" && candidate.customType === "agent-loop-state")
		.at(-1);
	return entry?.type === "custom" && typeof entry.data === "object" && entry.data !== null
		? (entry.data as Record<string, unknown>)
		: undefined;
}

function userMessages(session: AgentSession): string[] {
	return session.messages.filter((message) => message.role === "user").map((message) => contentText(message.content));
}

async function runScenario(
	name: string,
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
	command: string,
): Promise<Scenario> {
	const tempDirectory = join(tmpdir(), `pi-agent-loop-${name}-${Date.now()}`);
	const agentDirectory = join(tempDirectory, "agent");
	mkdirSync(agentDirectory, { recursive: true });
	const faux = fauxProvider();
	faux.setResponses(responses);
	const modelRuntime = await ModelRuntime.create();
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.create(tempDirectory, agentDirectory);
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDirectory,
		agentDir: agentDirectory,
		settingsManager,
		extensionFactories: [agentLoopExtension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: tempDirectory,
		agentDir: agentDirectory,
		model: faux.getModel(),
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
	});
	await session.bindExtensions({});
	await session.prompt(command);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await session.waitForIdle();
	return {
		session,
		sessionManager,
		faux,
		async cleanup() {
			await session.shutdownExtensions("quit");
			session.dispose();
			rmSync(tempDirectory, { recursive: true, force: true });
		},
	};
}

async function main(): Promise<void> {
	const parsed = parseStartOptions("Refine the implementation --max-iterations=3 --max-tools 8 --timeout-minutes=2");
	assert(parsed.goal === "Refine the implementation", "loop command options are removed from the goal");
	assert(parsed.maxIterations === 3 && parsed.maxToolCalls === 8 && parsed.timeoutMinutes === 2, "loop limits parse");

	const completed = await runScenario(
		"complete",
		[
			fauxAssistantMessage(
				fauxToolCall(CHECKPOINT_TOOL, {
					status: "continue",
					summary: "Implemented the first pass",
					evidence: "Initial checks passed",
					next_action: "Run the final verification",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Iteration one checkpointed."),
			fauxAssistantMessage(
				fauxToolCall(CHECKPOINT_TOOL, {
					status: "complete",
					summary: "Implementation and verification completed",
					evidence: "All deterministic checks passed",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Loop complete."),
		],
		"/agent-loop start Build and verify the bounded loop --max-iterations=3 --max-tools=10 --timeout-minutes=2",
	);
	assert(
		completed.session.agent.state.tools.some((tool) => tool.name === CHECKPOINT_TOOL),
		"checkpoint tool is registered in a real AgentSession",
	);
	assert(userMessages(completed.session).length === 2, "continue checkpoint schedules exactly one follow-up run");
	assert(userMessages(completed.session)[1]?.includes("iteration 2/3"), "follow-up carries the next iteration");
	assert(finalState(completed.sessionManager) !== undefined, "loop state is persisted as session entries");
	assert(finalState(completed.sessionManager)?.status === "completed", "complete checkpoint terminates the loop");
	assert(completed.faux.state.callCount === 4, "two full iterations use the faux model deterministically");
	await completed.cleanup();

	const iterationBound = await runScenario(
		"iteration-bound",
		[
			fauxAssistantMessage(
				fauxToolCall(CHECKPOINT_TOOL, {
					status: "continue",
					summary: "More work remains",
					evidence: "One partial result",
					next_action: "Continue",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Requested another iteration."),
		],
		"/agent-loop start Bounded task --max-iterations=1",
	);
	assert(finalState(iterationBound.sessionManager)?.status === "exhausted", "maxIterations stops continuation");
	assert(userMessages(iterationBound.session).length === 1, "iteration exhaustion does not queue another turn");
	await iterationBound.cleanup();

	const missingCheckpoint = await runScenario(
		"missing-checkpoint",
		[fauxAssistantMessage("I forgot to checkpoint.")],
		"/agent-loop start Require checkpoint --max-iterations=2",
	);
	assert(finalState(missingCheckpoint.sessionManager)?.status === "paused", "missing checkpoint pauses fail-closed");
	await missingCheckpoint.cleanup();

	const toolBound = await runScenario(
		"tool-bound",
		[
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf work" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall(CHECKPOINT_TOOL, {
					status: "continue",
					summary: "Used the available tool budget",
					evidence: "printf completed",
					next_action: "More tool work",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Requested more work."),
		],
		"/agent-loop start Tool-bound task --max-iterations=3 --max-tools=1",
	);
	assert(finalState(toolBound.sessionManager)?.status === "exhausted", "tool-call budget stops continuation");
	assert(finalState(toolBound.sessionManager)?.toolCalls === 1, "tool-call budget counts real tool execution");
	await toolBound.cleanup();

	console.log(`\nResults: ${passed} passed, 0 failed`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
