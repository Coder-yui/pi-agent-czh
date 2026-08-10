import { Annotation, END, GraphRecursionError, START, StateGraph } from "@langchain/langgraph";
import type { AgentGraphDefinition, AgentGraphEdge, AgentGraphNode } from "./schema.ts";

const NODE_OUTPUT_LIMIT = 64 * 1024;

type GraphNodeStatus = "success" | "failure" | "approved" | "rejected";
type GraphRunStatus = "completed" | "failed" | "exhausted" | "canceled";

interface GraphNodeResult {
	nodeId: string;
	nodeType: AgentGraphNode["type"];
	status: GraphNodeStatus;
	output: string;
	exitCode?: number;
	startedAt: number;
	completedAt: number;
}

interface GraphTraceEntry extends GraphNodeResult {
	visit: number;
}

interface GraphRunResult {
	graph: string;
	status: GraphRunStatus;
	input: string;
	output: string;
	outputs: Record<string, GraphNodeResult>;
	visits: Record<string, number>;
	trace: GraphTraceEntry[];
	error?: string;
}

type GraphRunEvent =
	| { type: "node_start"; nodeId: string; visit: number }
	| { type: "node_end"; result: GraphTraceEntry }
	| { type: "route"; from: string; to: string };

interface GraphNodeExecutionContext {
	input: string;
	task: string;
	outputs: Readonly<Record<string, GraphNodeResult>>;
	lastResult: GraphNodeResult | null;
	visit: number;
	signal?: AbortSignal;
}

type GraphNodeExecutor = (node: AgentGraphNode, context: GraphNodeExecutionContext) => Promise<GraphNodeResult>;

interface RunAgentGraphOptions {
	signal?: AbortSignal;
	onEvent?: (event: GraphRunEvent) => void;
}

const GraphState = Annotation.Root({
	input: Annotation<string>(),
	outputs: Annotation<Record<string, GraphNodeResult>>({
		reducer: (left, right) => ({ ...left, ...right }),
		default: () => ({}),
	}),
	visits: Annotation<Record<string, number>>({
		reducer: (left, right) => ({ ...left, ...right }),
		default: () => ({}),
	}),
	trace: Annotation<GraphTraceEntry[]>({
		reducer: (left, right) => left.concat(right),
		default: () => [],
	}),
	lastResult: Annotation<GraphNodeResult | null>(),
});

type GraphStateValue = typeof GraphState.State;

function truncateOutput(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= NODE_OUTPUT_LIMIT) return output;
	let truncated = output.slice(0, NODE_OUTPUT_LIMIT);
	while (Buffer.byteLength(truncated, "utf8") > NODE_OUTPUT_LIMIT) truncated = truncated.slice(0, -1);
	return `${truncated}\n[output truncated]`;
}

function renderTemplate(template: string, state: GraphStateValue): string {
	return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawKey: string) => {
		const key = rawKey.trim();
		if (key === "input") return state.input;
		if (key === "last_output") return state.lastResult?.output ?? "";
		if (key.startsWith("outputs.")) return state.outputs[key.slice("outputs.".length)]?.output ?? "";
		throw new Error(`Unsupported graph template variable: ${key}`);
	});
}

function edgeMatches(edge: AgentGraphEdge, result: GraphNodeResult): boolean {
	switch (edge.when) {
		case "always":
			return true;
		case "success":
			return result.status === "success";
		case "failure":
			return result.status === "failure";
		case "approved":
			return result.status === "approved";
		case "rejected":
			return result.status === "rejected";
		case "output_contains":
			return result.output.includes(edge.contains ?? "");
	}
}

function chooseNextNode(definition: AgentGraphDefinition, nodeId: string, result: GraphNodeResult): string {
	const edge = definition.edges.find((candidate) => candidate.from === nodeId && edgeMatches(candidate, result));
	return edge?.to ?? END;
}

function makeSyntheticFailure(node: AgentGraphNode, message: string, startedAt: number): GraphNodeResult {
	return {
		nodeId: node.id,
		nodeType: node.type,
		status: "failure",
		output: message,
		startedAt,
		completedAt: Date.now(),
	};
}

async function runAgentGraph(
	definition: AgentGraphDefinition,
	input: string,
	executeNode: GraphNodeExecutor,
	options: RunAgentGraphOptions = {},
): Promise<GraphRunResult> {
	const runtimeTrace: GraphTraceEntry[] = [];
	const runtimeOutputs: Record<string, GraphNodeResult> = {};
	const runtimeVisits: Record<string, number> = {};
	const nodeMap: Record<string, (state: GraphStateValue) => Promise<Partial<GraphStateValue>>> = {};

	for (const node of definition.nodes) {
		nodeMap[node.id] = async (state) => {
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("Agent Graph canceled");
			const visit = (state.visits[node.id] ?? 0) + 1;
			options.onEvent?.({ type: "node_start", nodeId: node.id, visit });
			const startedAt = Date.now();
			let result: GraphNodeResult;
			if (node.maxVisits !== undefined && visit > node.maxVisits) {
				result = makeSyntheticFailure(node, `Node ${node.id} exceeded maxVisits=${node.maxVisits}`, startedAt);
			} else {
				try {
					const task = renderTemplate(node.type === "agent" ? node.task : node.message, state);
					const executed = await executeNode(node, {
						input: state.input,
						task,
						outputs: state.outputs,
						lastResult: state.lastResult,
						visit,
						signal: options.signal,
					});
					if (options.signal?.aborted) throw options.signal.reason ?? new Error("Agent Graph canceled");
					result = {
						...executed,
						nodeId: node.id,
						nodeType: node.type,
						output: truncateOutput(executed.output),
						startedAt,
						completedAt: Date.now(),
					};
				} catch (error) {
					if (options.signal?.aborted) throw error;
					result = makeSyntheticFailure(node, error instanceof Error ? error.message : String(error), startedAt);
				}
			}
			const traceEntry: GraphTraceEntry = { ...result, visit };
			runtimeTrace.push(traceEntry);
			runtimeOutputs[node.id] = result;
			runtimeVisits[node.id] = visit;
			options.onEvent?.({ type: "node_end", result: traceEntry });
			return {
				outputs: { [node.id]: result },
				visits: { [node.id]: visit },
				trace: [traceEntry],
				lastResult: result,
			};
		};
	}

	const builder = new StateGraph(GraphState).addNode(nodeMap).addEdge(START, definition.entrypoint);
	for (const node of definition.nodes) {
		builder.addConditionalEdges(node.id, (state) => {
			const result = state.lastResult;
			const target = result ? chooseNextNode(definition, node.id, result) : END;
			options.onEvent?.({ type: "route", from: node.id, to: target });
			return target;
		});
	}
	const graph = builder.compile({ name: definition.name, description: definition.description });

	try {
		const finalState = await graph.invoke(
			{ input, outputs: {}, visits: {}, trace: [], lastResult: null },
			{ recursionLimit: definition.maxSteps + 1, signal: options.signal },
		);
		const finalResult = finalState.lastResult;
		return {
			graph: definition.name,
			status: finalResult?.status === "failure" ? "failed" : "completed",
			input,
			output: finalResult?.output ?? "",
			outputs: finalState.outputs,
			visits: finalState.visits,
			trace: finalState.trace,
		};
	} catch (error) {
		if (options.signal?.aborted) {
			return {
				graph: definition.name,
				status: "canceled",
				input,
				output: runtimeTrace.at(-1)?.output ?? "",
				outputs: runtimeOutputs,
				visits: runtimeVisits,
				trace: runtimeTrace,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		const exhausted = error instanceof GraphRecursionError;
		return {
			graph: definition.name,
			status: exhausted ? "exhausted" : "failed",
			input,
			output: runtimeTrace.at(-1)?.output ?? "",
			outputs: runtimeOutputs,
			visits: runtimeVisits,
			trace: runtimeTrace,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export {
	chooseNextNode,
	edgeMatches,
	renderTemplate,
	runAgentGraph,
	type GraphNodeExecutionContext,
	type GraphNodeExecutor,
	type GraphNodeResult,
	type GraphNodeStatus,
	type GraphRunEvent,
	type GraphRunResult,
	type GraphRunStatus,
	type GraphTraceEntry,
	type RunAgentGraphOptions,
};
