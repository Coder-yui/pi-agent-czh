import { z } from "zod";

const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GRAPH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const NodeBaseSchema = z.object({
	id: z.string().regex(NODE_ID_PATTERN, "Node IDs must be safe identifiers of at most 64 characters"),
	description: z.string().max(500).optional(),
	maxVisits: z.number().int().min(1).max(100).optional(),
});

const AgentNodeSchema = NodeBaseSchema.extend({
	type: z.literal("agent"),
	task: z.string().min(1).max(50_000),
	systemPrompt: z.string().max(50_000).optional(),
	model: z.string().min(1).max(300).optional(),
	tools: z.array(z.string().min(1).max(100)).max(100).optional(),
	cwd: z.string().min(1).max(1000).optional(),
	timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
}).strict();

const ApprovalNodeSchema = NodeBaseSchema.extend({
	type: z.literal("approval"),
	title: z.string().min(1).max(200),
	message: z.string().min(1).max(10_000),
}).strict();

const EdgeSchema = z
	.object({
		from: z.string().regex(NODE_ID_PATTERN),
		to: z.union([z.string().regex(NODE_ID_PATTERN), z.literal("__end__")]),
		when: z.enum(["always", "success", "failure", "approved", "rejected", "output_contains"]).default("always"),
		contains: z.string().min(1).max(1000).optional(),
	})
	.strict()
	.superRefine((edge, ctx) => {
		if (edge.when === "output_contains" && !edge.contains) {
			ctx.addIssue({ code: "custom", message: "output_contains edges require contains" });
		}
		if (edge.when !== "output_contains" && edge.contains !== undefined) {
			ctx.addIssue({ code: "custom", message: "contains is only valid for output_contains edges" });
		}
	});

const AgentGraphDefinitionSchema = z
	.object({
		version: z.literal(1),
		name: z.string().regex(GRAPH_NAME_PATTERN, "Graph names must be safe identifiers of at most 64 characters"),
		description: z.string().max(1000).optional(),
		entrypoint: z.string().regex(NODE_ID_PATTERN),
		maxSteps: z.number().int().min(1).max(200).default(25),
		nodes: z
			.array(z.discriminatedUnion("type", [AgentNodeSchema, ApprovalNodeSchema]))
			.min(1)
			.max(50),
		edges: z.array(EdgeSchema).max(200),
	})
	.strict()
	.superRefine((definition, ctx) => {
		const ids = new Set<string>();
		for (const [index, node] of definition.nodes.entries()) {
			if (ids.has(node.id)) {
				ctx.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `Duplicate node ID: ${node.id}` });
			}
			ids.add(node.id);
		}
		if (!ids.has(definition.entrypoint)) {
			ctx.addIssue({ code: "custom", path: ["entrypoint"], message: "Entrypoint must reference a node" });
		}

		const outgoing = new Map<string, Array<{ index: number; when: string }>>();
		for (const [index, edge] of definition.edges.entries()) {
			if (!ids.has(edge.from)) {
				ctx.addIssue({ code: "custom", path: ["edges", index, "from"], message: `Unknown source: ${edge.from}` });
			}
			if (edge.to !== "__end__" && !ids.has(edge.to)) {
				ctx.addIssue({ code: "custom", path: ["edges", index, "to"], message: `Unknown target: ${edge.to}` });
			}
			const list = outgoing.get(edge.from) ?? [];
			list.push({ index, when: edge.when });
			outgoing.set(edge.from, list);
		}
		for (const [nodeId, edges] of outgoing) {
			const defaults = edges.filter((edge) => edge.when === "always");
			if (defaults.length > 1) {
				ctx.addIssue({ code: "custom", message: `Node ${nodeId} has more than one always edge` });
			}
			if (defaults.length === 1 && defaults[0]?.index !== edges.at(-1)?.index) {
				ctx.addIssue({ code: "custom", message: `Node ${nodeId}'s always edge must be its final fallback edge` });
			}
		}

		if (ids.has(definition.entrypoint)) {
			const reachable = new Set<string>();
			const queue = [definition.entrypoint];
			while (queue.length > 0) {
				const current = queue.shift();
				if (!current || reachable.has(current)) continue;
				reachable.add(current);
				for (const edge of definition.edges) {
					if (edge.from === current && edge.to !== "__end__" && !reachable.has(edge.to)) queue.push(edge.to);
				}
			}
			for (const [index, node] of definition.nodes.entries()) {
				if (!reachable.has(node.id)) {
					ctx.addIssue({ code: "custom", path: ["nodes", index], message: `Node ${node.id} is unreachable` });
				}
			}
		}
	});

type AgentGraphDefinition = z.infer<typeof AgentGraphDefinitionSchema>;
type AgentGraphNode = AgentGraphDefinition["nodes"][number];
type AgentGraphEdge = AgentGraphDefinition["edges"][number];
type AgentGraphAgentNode = Extract<AgentGraphNode, { type: "agent" }>;
type AgentGraphApprovalNode = Extract<AgentGraphNode, { type: "approval" }>;

function parseAgentGraphDefinition(value: unknown): AgentGraphDefinition {
	return AgentGraphDefinitionSchema.parse(value);
}

function formatGraphValidationError(error: unknown): string {
	if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
	return error.issues
		.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "graph"}: ${issue.message}`)
		.join("\n");
}

export {
	AgentGraphDefinitionSchema,
	formatGraphValidationError,
	parseAgentGraphDefinition,
	type AgentGraphAgentNode,
	type AgentGraphApprovalNode,
	type AgentGraphDefinition,
	type AgentGraphEdge,
	type AgentGraphNode,
};
