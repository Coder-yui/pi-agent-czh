/** Agent Graph extension backed by the official LangGraph.js StateGraph runtime. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentToolUpdateCallback,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GraphNodeExecutor, type GraphRunEvent, type GraphRunResult, runAgentGraph } from "./engine.ts";
import { createPiProcessNodeExecutor } from "./process-node.ts";
import {
	type AgentGraphDefinition,
	type AgentGraphNode,
	formatGraphValidationError,
	parseAgentGraphDefinition,
} from "./schema.ts";

const GRAPH_ENTRY = "agent-graph-run";
const GRAPH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GRAPH_FILE_LIMIT = 1024 * 1024;

interface LocatedGraph {
	definition: AgentGraphDefinition;
	path: string;
	source: "user" | "project";
}

interface AgentGraphExtensionOptions {
	nodeExecutor?: GraphNodeExecutor;
	/** Test/embedding override. Production defaults to requiring confirmation for project-controlled graphs. */
	confirmProjectGraphs?: boolean;
}

interface GraphToolDetails {
	run?: GraphRunResult;
	error?: string;
}

const RunGraphParams = Type.Object({
	graph: Type.String({ minLength: 1, description: "Graph name from ~/.pi/agent/agent-graphs or .pi/agent-graphs" }),
	input: Type.String({ description: "Input made available as {{input}} to graph node templates" }),
});

function graphDirectories(cwd: string): Array<{ directory: string; source: LocatedGraph["source"] }> {
	return [
		{ directory: join(getAgentDir(), "agent-graphs"), source: "user" },
		{ directory: join(cwd, ".pi", "agent-graphs"), source: "project" },
	];
}

function listGraphNames(cwd: string): string[] {
	const names = new Set<string>();
	for (const { directory } of graphDirectories(cwd)) {
		if (!existsSync(directory)) continue;
		for (const file of readdirSync(directory)) {
			if (file.endsWith(".json") && GRAPH_NAME_PATTERN.test(file.slice(0, -5))) names.add(file.slice(0, -5));
		}
	}
	return [...names].sort();
}

function loadGraph(cwd: string, name: string): LocatedGraph {
	if (!GRAPH_NAME_PATTERN.test(name)) throw new Error("Invalid Agent Graph name");
	let located: { path: string; source: LocatedGraph["source"] } | undefined;
	for (const candidate of graphDirectories(cwd)) {
		const path = join(candidate.directory, `${name}.json`);
		if (existsSync(path)) located = { path, source: candidate.source };
	}
	if (!located) throw new Error(`Agent Graph not found: ${name}`);
	const raw = readFileSync(located.path, "utf8");
	if (Buffer.byteLength(raw, "utf8") > GRAPH_FILE_LIMIT) throw new Error("Agent Graph definition exceeds 1 MiB");
	try {
		return { definition: parseAgentGraphDefinition(JSON.parse(raw) as unknown), ...located };
	} catch (error) {
		throw new Error(`Invalid Agent Graph ${name}:\n${formatGraphValidationError(error)}`, { cause: error });
	}
}

function describeGraph(graph: LocatedGraph): string {
	const { definition } = graph;
	return [
		`${definition.name} (${graph.source})`,
		definition.description ?? "No description",
		`Entrypoint: ${definition.entrypoint}`,
		`Limits: ${definition.maxSteps} LangGraph steps`,
		"Nodes:",
		...definition.nodes.map(
			(node) => `- ${node.id} [${node.type}]${node.maxVisits ? ` maxVisits=${node.maxVisits}` : ""}`,
		),
		"Edges:",
		...definition.edges.map(
			(edge) => `- ${edge.from} -> ${edge.to} when ${edge.when}${edge.contains ? `(${edge.contains})` : ""}`,
		),
	].join("\n");
}

function formatRunResult(result: GraphRunResult): string {
	const route = result.trace.map((entry) => `${entry.nodeId}#${entry.visit}:${entry.status}`).join(" -> ");
	return [
		`Agent Graph ${result.graph}: ${result.status}`,
		`Route: ${route || "(no nodes executed)"}`,
		result.error ? `Error: ${result.error}` : undefined,
		"Output:",
		result.output || "(no output)",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function progressText(event: GraphRunEvent): string {
	switch (event.type) {
		case "node_start":
			return `Running ${event.nodeId} (visit ${event.visit})`;
		case "node_end":
			return `${event.result.nodeId} finished: ${event.result.status}`;
		case "route":
			return `Route ${event.from} -> ${event.to}`;
	}
}

function makeApprovalResult(node: AgentGraphNode, approved: boolean, startedAt: number) {
	return {
		nodeId: node.id,
		nodeType: node.type,
		status: approved ? ("approved" as const) : ("rejected" as const),
		output: approved ? "approved" : "rejected",
		startedAt,
		completedAt: Date.now(),
	};
}

function createAgentGraphExtension(options: AgentGraphExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		async function executeLocatedGraph(
			located: LocatedGraph,
			input: string,
			ctx: ExtensionContext,
			signal: AbortSignal | undefined,
			onUpdate?: AgentToolUpdateCallback<GraphToolDetails>,
		): Promise<GraphRunResult> {
			const processExecutor = options.nodeExecutor ?? createPiProcessNodeExecutor(ctx.cwd);
			const executor: GraphNodeExecutor = async (node, executionContext) => {
				if (node.type === "approval") {
					const startedAt = Date.now();
					if (!ctx.hasUI) return makeApprovalResult(node, false, startedAt);
					const approved = await ctx.ui.confirm(node.title, executionContext.task, { signal });
					return makeApprovalResult(node, approved, startedAt);
				}
				return processExecutor(node, executionContext);
			};
			const result = await runAgentGraph(located.definition, input, executor, {
				signal,
				onEvent: onUpdate
					? (event) =>
							onUpdate({
								content: [{ type: "text", text: progressText(event) }],
								details: {},
							})
					: undefined,
			});
			pi.appendEntry(GRAPH_ENTRY, {
				graph: result.graph,
				status: result.status,
				trace: result.trace.map(({ nodeId, nodeType, status, visit, startedAt, completedAt }) => ({
					nodeId,
					nodeType,
					status,
					visit,
					startedAt,
					completedAt,
				})),
				completedAt: Date.now(),
			});
			return result;
		}

		pi.registerTool({
			name: "agent_graph_run",
			label: "Run Agent Graph",
			description:
				"Run a validated LangGraph.js StateGraph whose agent nodes use isolated full pi processes and whose approval nodes require human input.",
			promptSnippet: "Run a named, validated Agent Graph with conditional routes and bounded cycles",
			parameters: RunGraphParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				try {
					const located = loadGraph(ctx.cwd, params.graph);
					if (located.source === "project" && !ctx.isProjectTrusted()) {
						throw new Error("Project Agent Graphs require a trusted project");
					}
					if (located.source === "project" && (options.confirmProjectGraphs ?? true)) {
						if (!ctx.hasUI) throw new Error("Project Agent Graph confirmation requires an interactive client");
						const approved = await ctx.ui.confirm(
							"Run project Agent Graph?",
							`${located.path}\n\n${located.definition.nodes.length} nodes, max ${located.definition.maxSteps} steps`,
							{ signal },
						);
						if (!approved) throw new Error("Project Agent Graph was not approved");
					}
					const result = await executeLocatedGraph(located, params.input, ctx, signal, onUpdate);
					return {
						content: [{ type: "text", text: formatRunResult(result) }],
						details: { run: result } satisfies GraphToolDetails,
						isError: result.status !== "completed",
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: message }],
						details: { error: message } satisfies GraphToolDetails,
						isError: true,
					};
				}
			},
		});

		pi.registerCommand("agent-graph", {
			description: "Manage Agent Graphs: /agent-graph list|show|validate|run",
			handler: async (args, ctx) => {
				const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
				const action = match?.[1]?.toLowerCase() ?? "list";
				const remainder = match?.[2]?.trim() ?? "";
				try {
					switch (action) {
						case "list": {
							const names = listGraphNames(ctx.cwd);
							ctx.ui.notify(names.length > 0 ? names.join("\n") : "No Agent Graph definitions found.", "info");
							return;
						}
						case "show":
						case "validate": {
							if (!remainder) throw new Error(`Usage: /agent-graph ${action} <name>`);
							const located = loadGraph(ctx.cwd, remainder);
							ctx.ui.notify(action === "show" ? describeGraph(located) : `${remainder}: valid`, "info");
							return;
						}
						case "run": {
							const runMatch = remainder.match(/^(\S+)(?:\s+([\s\S]*))?$/);
							if (!runMatch) throw new Error("Usage: /agent-graph run <name> <input>");
							const located = loadGraph(ctx.cwd, runMatch[1]);
							if (located.source === "project" && !ctx.isProjectTrusted()) {
								throw new Error("Project Agent Graphs require a trusted project");
							}
							const result = await executeLocatedGraph(located, runMatch[2] ?? "", ctx, ctx.signal);
							ctx.ui.notify(formatRunResult(result), result.status === "completed" ? "info" : "error");
							return;
						}
						default:
							throw new Error("Usage: /agent-graph list | show <name> | validate <name> | run <name> <input>");
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}

const agentGraphExtension = createAgentGraphExtension();

export default agentGraphExtension;
export {
	createAgentGraphExtension,
	describeGraph,
	formatRunResult,
	graphDirectories,
	listGraphNames,
	loadGraph,
	type AgentGraphExtensionOptions,
	type GraphToolDetails,
	type LocatedGraph,
};
