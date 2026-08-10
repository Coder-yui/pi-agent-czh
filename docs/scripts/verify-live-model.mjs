#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const cli = join(repositoryRoot, "packages/coding-agent/dist/cli.js");
const tsx = join(repositoryRoot, "node_modules/.bin/tsx");
const provider = process.env.PI_PROVIDER?.trim() || "deepseek";
const model = process.env.PI_MODEL?.trim() || "deepseek-v4-pro";
const require = createRequire(import.meta.url);
const filesystemServer = join(
	dirname(require.resolve("@modelcontextprotocol/server-filesystem/package.json")),
	"dist",
	"index.js",
);

const extensions = {
	mcp: join(repositoryRoot, "packages/coding-agent/examples/extensions/mcp/index.ts"),
	memory: join(repositoryRoot, "packages/coding-agent/examples/extensions/memory/index.ts"),
	sandbox: join(repositoryRoot, "packages/coding-agent/examples/extensions/sandbox/index.ts"),
	planReflect: join(repositoryRoot, "packages/coding-agent/examples/extensions/plan-reflect/index.ts"),
	economy: join(repositoryRoot, "packages/coding-agent/examples/extensions/economy/index.ts"),
	agentGraph: join(repositoryRoot, "packages/coding-agent/examples/extensions/agent-graph/index.ts"),
};

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(value) {
	if (!isRecord(value) || !Array.isArray(value.content)) return "";
	return value.content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function parseEvents(stdout) {
	return stdout
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				const event = JSON.parse(line);
				return isRecord(event) ? [event] : [];
			} catch {
				return [];
			}
		});
}

function toolNames(events) {
	return events
		.filter((event) => event.type === "tool_execution_start" && typeof event.toolName === "string")
		.map((event) => event.toolName);
}

function toolOutput(events, toolName) {
	return events
		.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName)
		.map((event) => (isRecord(event.result) ? textContent(event.result) : ""))
		.join("\n");
}

function assistantOutput(events) {
	return events
		.filter(
			(event) =>
				event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant",
		)
		.map((event) => textContent(event.message))
		.join("\n");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function runCli(label, cwd, extraArgs, prompt, extraEnv = {}) {
	const result = spawnSync(
		process.execPath,
		[
			cli,
			"--provider",
			provider,
			"--model",
			model,
			"--mode",
			"json",
			"--print",
			"--no-session",
			"--no-context-files",
			...extraArgs,
			prompt,
		],
		{
			cwd,
			encoding: "utf8",
			timeout: 240_000,
			maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, ...extraEnv },
		},
	);
	if (result.status !== 0) {
		throw new Error(
			`${label} failed with exit ${result.status ?? "unknown"}\n${result.stderr || result.stdout}`,
		);
	}
	const events = parseEvents(result.stdout);
	console.log(`  PASS ${label}`);
	return events;
}

function runProtocolChecks(root) {
	const scripts = [
		join(scriptDirectory, "verify-live-protocols.ts"),
		join(repositoryRoot, "packages/coding-agent/examples/extensions/acp/scripts/live-test.ts"),
	];
	for (const script of scripts) {
		const result = spawnSync(tsx, [script], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 360_000,
			maxBuffer: 16 * 1024 * 1024,
			env: {
				...process.env,
				PI_PROVIDER: provider,
				PI_MODEL: model,
				PI_LIVE_TEST_ROOT: join(root, "protocols"),
			},
		});
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		if (result.status !== 0) {
			throw new Error(`${script} failed with exit ${result.status ?? "unknown"}`);
		}
	}
}

function main() {
	assert(readFileSync(cli).length > 0, "Missing built pi CLI. Run npm run build:offline first.");
	const root = mkdtempSync(join(tmpdir(), "pi-live-model-"));
	const workspace = join(root, "workspace");
	mkdirSync(join(workspace, ".pi", "agent-graphs"), { recursive: true });
	writeFileSync(join(workspace, "fixture.txt"), "MCP_LIVE_FIXTURE_7391\n", "utf8");
	writeFileSync(
		join(workspace, ".pi", "mcp.json"),
		JSON.stringify(
			{
				mcpServers: {
					filesystem: { command: process.execPath, args: [filesystemServer, workspace] },
				},
			},
			null,
			2,
		),
		"utf8",
	);
	writeFileSync(
		join(workspace, ".pi", "agent-graphs", "live-graph.json"),
		JSON.stringify(
			{
				version: 1,
				name: "live-graph",
				description: "Two real pi/DeepSeek nodes for live adapter validation",
				entrypoint: "draft",
				maxSteps: 4,
				nodes: [
					{
						id: "draft",
						type: "agent",
						task: "Reply with exactly DRAFT_OK and the input: {{input}}",
						model: `${provider}/${model}`,
						tools: ["read"],
					},
					{
						id: "review",
						type: "agent",
						task: "Reply with exactly REVIEW_OK and quote this prior output: {{last_output}}",
						model: `${provider}/${model}`,
						tools: ["read"],
					},
				],
				edges: [
					{ from: "draft", to: "review", when: "success" },
					{ from: "draft", to: "__end__", when: "always" },
					{ from: "review", to: "__end__", when: "always" },
				],
			},
			null,
			2,
		),
		"utf8",
	);

	console.log(`Live model integration: ${provider}/${model}`);
	try {
		const mcp = runCli(
			"DeepSeek invoked MCP filesystem",
			workspace,
			["--no-builtin-tools", "-e", extensions.mcp],
			`Call mcp__filesystem__read_text_file exactly once with path ${join(workspace, "fixture.txt")}. Then reply MCP_LIVE_OK.`,
		);
		assert(toolNames(mcp).includes("mcp__filesystem__read_text_file"), "DeepSeek did not call the MCP tool");
		assert(toolOutput(mcp, "mcp__filesystem__read_text_file").includes("MCP_LIVE_FIXTURE_7391"), "MCP result was not returned to pi");

		const memory = runCli(
			"DeepSeek wrote and searched long-term memory",
			workspace,
			["--no-builtin-tools", "-e", extensions.memory],
			"Call memory__add_fact with entity LiveHarness, entityType Test, and fact MEMORY_LIVE_FACT_4826. Then call memory__search with query LiveHarness. Finally reply MEMORY_LIVE_OK.",
		);
		assert(toolNames(memory).includes("memory__add_fact"), "DeepSeek did not call memory__add_fact");
		assert(toolNames(memory).includes("memory__search"), "DeepSeek did not call memory__search");
		assert(toolOutput(memory, "memory__search").includes("MEMORY_LIVE_FACT_4826"), "Memory entity search did not return the stored fact");
		assert(readFileSync(join(workspace, ".pi", "memory.jsonl"), "utf8").includes("MEMORY_LIVE_FACT_4826"), "Memory fact was not persisted");

		const sandbox = runCli(
			"DeepSeek executed bash through Sandbox",
			workspace,
			["--tools", "bash", "-e", extensions.sandbox],
			"Call bash exactly once with command: printf SANDBOX_LIVE_OK. Then report the output.",
		);
		assert(toolNames(sandbox).includes("bash"), "DeepSeek did not call sandboxed bash");
		assert(toolOutput(sandbox, "bash").includes("SANDBOX_LIVE_OK"), "Sandboxed bash output was not returned");

		const planning = runCli(
			"DeepSeek followed Plan/Reflect planning injection",
			workspace,
			["--tools", "bash", "-e", extensions.planReflect, "--plan", "on"],
			"Implement this two-step verification: first use bash to run printf PLAN_LIVE_OK, then report the verified output. Follow all injected planning instructions.",
		);
		assert(toolNames(planning).includes("bash"), "Planned run did not execute its step");
		assert(/Plan:/i.test(assistantOutput(planning)), "DeepSeek did not emit the injected plan");

		const economy = runCli(
			"DeepSeek invoked Economy DID tooling",
			workspace,
			["--no-builtin-tools", "-e", extensions.economy],
			"Call did_show exactly once, then reply ECONOMY_LIVE_OK.",
			{ PI_AGENT_ECONOMY_HOME: join(root, "economy-home") },
		);
		assert(toolNames(economy).includes("did_show"), "DeepSeek did not call did_show");
		assert(toolOutput(economy, "did_show").includes("did:key:"), "Economy did_show did not return a DID");

		const graph = runCli(
			"Agent Graph ran two isolated DeepSeek nodes",
			workspace,
			["--approve", "--no-builtin-tools", "-e", extensions.agentGraph],
			"/agent-graph run live-graph GRAPH_INPUT_1954",
		);
		const graphEntry = graph.find(
			(event) =>
				event.type === "entry_appended" &&
				isRecord(event.entry) &&
				event.entry.customType === "agent-graph-run",
		);
		assert(graphEntry && isRecord(graphEntry.entry) && isRecord(graphEntry.entry.data), "Agent Graph did not persist its live run");
		assert(graphEntry.entry.data.status === "completed", "Agent Graph live run did not complete");
		assert(Array.isArray(graphEntry.entry.data.trace) && graphEntry.entry.data.trace.length === 2, "Agent Graph did not execute both nodes");

		runProtocolChecks(root);
		console.log("\nLive result: 9/9 modern-agent integration checks passed.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
}
