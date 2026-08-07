/**
 * Memory extension for pi — long-term memory backed by the OFFICIAL
 * @modelcontextprotocol/server-memory Knowledge Graph MCP server.
 *
 * Design principle: this file is a thin glue layer. It does NOT implement
 * storage, retrieval, indexing, graph traversal, or persistence — the official
 * server (spawned as a child process via the MCP TypeScript SDK) handles all of
 * that. We only:
 *   1. Spawn `npx -y @modelcontextprotocol/server-memory` on session_start
 *      (persisting to `<cwd>/.pi/memory.json` via MEMORY_FILE_PATH env var).
 *   2. Expose a small set of LLM-friendly memory__* tools that forward to the
 *      official server over MCP (add_fact, search, read_graph, create_relations,
 *      forget_entity).
 *   3. Auto-inject the full knowledge graph into the system prompt before every
 *      agent turn via the before_agent_start event.
 *   4. Provide /memory and /memory-forget slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectedMemory {
	client: Client;
	transport: StdioClientTransport;
	memoryFile: string;
}

interface PluginState {
	mem?: ConnectedMemory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(result: any): string {
	const items = (result?.content ?? []) as Array<{ type: string; text?: string }>;
	return items
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

function textBlock(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function errorBlock(msg: string) {
	return { content: [{ type: "text" as const, text: `[memory error] ${msg}` }], details: { error: msg } };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function spawnMemoryServer(memoryFile: string): Promise<ConnectedMemory> {
	mkdirSync(join(memoryFile, ".."), { recursive: true });
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-memory"],
		env: { ...process.env, MEMORY_FILE_PATH: memoryFile },
	});
	const client = new Client({ name: "pi-memory-extension", version: "0.1.0" });
	await client.connect(transport);
	return { client, transport, memoryFile };
}

async function shutdown(state: PluginState) {
	if (!state.mem) return;
	try { await state.mem.transport.close(); } catch { /* ignore */ }
	state.mem = undefined;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default async function memoryExtension(pi: ExtensionAPI) {
	const state: PluginState = {};

	pi.on("session_start", async (_event, ctx) => {
		await shutdown(state);
		// Official server-memory uses JSONL format (2026.x). Persist to <cwd>/.pi/memory.jsonl.
		const memoryFile = join(ctx.cwd, ".pi", "memory.jsonl");
		try {
			state.mem = await spawnMemoryServer(memoryFile);
			ctx.ui.setStatus("memory", `Memory KG: ${memoryFile}`);
		} catch (e: any) {
			ctx.ui.setStatus("memory", "Memory: failed to start");
			console.error("[memory] failed to spawn server-memory:", e?.stack ?? e);
		}
	});

	pi.on("session_shutdown", async () => {
		await shutdown(state);
	});

	// ---- Auto-inject knowledge graph into system prompt each turn ----------
	pi.on("before_agent_start", async () => {
		if (!state.mem) return;
		try {
			const result: any = await state.mem.client.callTool({
				name: "read_graph",
				arguments: {},
			} as CallToolRequest["params"]);
			const raw = extractText(result);
			if (!raw) return;
			let graph: any;
			try { graph = JSON.parse(raw); } catch { return; }
			const entities: any[] = Array.isArray(graph.entities) ? graph.entities : [];
			const relations: any[] = Array.isArray(graph.relations) ? graph.relations : [];
			if (entities.length === 0 && relations.length === 0) return;

			const rendered =
				"## Long-term Memory (Knowledge Graph)\n" +
				`You have persistent long-term memory stored at ${state.mem.memoryFile}. ` +
				"Use the `memory__*` tools to add / search / update memory whenever you learn a " +
				"durable fact about the user, the project, their preferences, conventions, or decisions.\n\n" +
				"### Known Entities\n" +
				entities
					.map((e) =>
						`- **${e.name}** (${e.entityType ?? "Entity"}):\n` +
						(e.observations ?? []).map((o: string) => `    - ${o}`).join("\n"),
					)
					.join("\n") +
				(relations.length > 0
					? "\n\n### Known Relations\n" +
						relations.map((r) => `- ${r.from} --[${r.relationType}]--> ${r.to}`).join("\n")
					: "");

			return { systemPrompt: rendered };
		} catch (e: any) {
			console.error("[memory] auto-inject failed:", e?.message ?? e);
		}
	});

	// ---- LLM-facing tools --------------------------------------------------

	pi.registerTool({
		name: "memory__add_fact",
		label: "memory: add fact",
		description:
			"Add a single fact/observation to long-term memory. " +
			"Use this whenever you learn a durable fact, preference, decision, or project convention " +
			"that may be relevant in future conversations. Wraps the official MCP Knowledge Graph server.",
		parameters: Type.Object({
			entity: Type.String({
				description:
					'Entity this fact belongs to, e.g. "User", "Project", "Alice", "BackendAPI". ' +
					"The entity is created automatically if it does not yet exist.",
			}),
			entityType: Type.Optional(
				Type.String({ description: 'Type of entity, e.g. "Person", "Project", "Service". Default: "Entity".' }),
			),
			fact: Type.String({ description: "The observation / fact to remember, as a single concise sentence." }),
		}),
		async execute(_id, args) {
			if (!state.mem) return errorBlock("Memory server not started");
			const entity = String(args.entity);
			const fact = String(args.fact);
			const entityType = args.entityType ? String(args.entityType) : "Entity";
			try {
				// Try add_observations first (works if entity exists).
				let res: any = await state.mem.client.callTool({
					name: "add_observations",
					arguments: { observations: [{ entityName: entity, contents: [fact] }] },
				} as CallToolRequest["params"]);
				let text = extractText(res);
				if (/not found|unknown|does not exist|no entity/i.test(text)) {
					// Entity doesn't exist yet; create it with this observation.
					await state.mem.client.callTool({
						name: "create_entities",
						arguments: {
							entities: [{ name: entity, entityType, observations: [fact] }],
						},
					} as CallToolRequest["params"]);
					return textBlock(`Created new entity "${entity}" (${entityType}) and added fact: ${fact}`);
				}
				return textBlock(`Added fact to "${entity}": ${fact}`);
			} catch (e: any) {
				return errorBlock(`memory__add_fact failed: ${e?.message ?? String(e)}`);
			}
		},
	});

	pi.registerTool({
		name: "memory__search",
		label: "memory: search",
		description:
			"Search the long-term knowledge graph for entities/observations matching a free-text query. " +
			"Backed by the official MCP Knowledge Graph server.",
		parameters: Type.Object({
			query: Type.String({ description: "Free-text query (matched against entity names, types, and observations)." }),
		}),
		async execute(_id, args) {
			if (!state.mem) return errorBlock("Memory server not started");
			const res: any = await state.mem.client.callTool({
				name: "search_nodes",
				arguments: { query: String(args.query) },
			} as CallToolRequest["params"]);
			return textBlock(extractText(res) || "(no matches)");
		},
	});

	pi.registerTool({
		name: "memory__read_graph",
		label: "memory: read graph",
		description: "Return the full long-term memory knowledge graph (all entities, observations, relations).",
		parameters: Type.Object({}),
		async execute() {
			if (!state.mem) return errorBlock("Memory server not started");
			const res: any = await state.mem.client.callTool({
				name: "read_graph",
				arguments: {},
			} as CallToolRequest["params"]);
			return textBlock(extractText(res) || "(empty graph)");
		},
	});

	pi.registerTool({
		name: "memory__create_relations",
		label: "memory: create relations",
		description:
			"Create directed relations between existing entities in memory, " +
			'e.g. {from: "User", relationType: "uses", to: "Neovim"}.',
		parameters: Type.Object({
			relations: Type.Array(
				Type.Object({
					from: Type.String({ description: "Source entity name (must already exist)." }),
					relationType: Type.String({ description: 'Relation verb, e.g. "uses", "owns", "depends_on".' }),
					to: Type.String({ description: "Target entity name (must already exist)." }),
				}),
			),
		}),
		async execute(_id, args) {
			if (!state.mem) return errorBlock("Memory server not started");
			const res: any = await state.mem.client.callTool({
				name: "create_relations",
				arguments: { relations: args.relations },
			} as CallToolRequest["params"]);
			return textBlock(extractText(res) || `Created ${(args.relations as any[]).length} relation(s).`);
		},
	});

	pi.registerTool({
		name: "memory__forget_entity",
		label: "memory: forget entity",
		description: "Delete an entity (and its observations and attached relations) from long-term memory.",
		parameters: Type.Object({
			name: Type.String({ description: "Exact entity name to delete." }),
		}),
		async execute(_id, args) {
			if (!state.mem) return errorBlock("Memory server not started");
			await state.mem.client.callTool({
				name: "delete_entities",
				arguments: { entityNames: [String(args.name)] },
			} as CallToolRequest["params"]);
			return textBlock(`Deleted entity "${args.name}" (if it existed).`);
		},
	});

	// ---- Slash commands ----------------------------------------------------

	pi.registerCommand("memory", {
		description: "Show the current long-term memory knowledge graph",
		handler: async (_args, ctx) => {
			if (!state.mem) { ctx.ui.appendText("Memory server not started.\n"); return; }
			const res: any = await state.mem.client.callTool({
				name: "read_graph", arguments: {},
			} as CallToolRequest["params"]);
			const text = extractText(res) || "(empty graph)";
			ctx.ui.appendText(`Long-term memory (${state.mem.memoryFile}):\n\n${text}\n`);
		},
	});

	pi.registerCommand("memory-forget", {
		description: "Delete all entities from long-term memory (with confirmation)",
		handler: async (_args, ctx) => {
			if (!state.mem) { ctx.ui.appendText("Memory server not started.\n"); return; }
			const ok = await ctx.ui.confirm("Clear all memory?", "Delete all entities, relations, and observations? This cannot be undone.");
			if (!ok) { ctx.ui.appendText("Cancelled.\n"); return; }
			const res: any = await state.mem.client.callTool({
				name: "read_graph", arguments: {},
			} as CallToolRequest["params"]);
			const graph = JSON.parse(extractText(res) || '{"entities":[]}');
			const names = (graph.entities ?? []).map((e: any) => e.name);
			if (names.length > 0) {
				await state.mem.client.callTool({
					name: "delete_entities",
					arguments: { entityNames: names },
				} as CallToolRequest["params"]);
			}
			ctx.ui.appendText(`Cleared ${names.length} entities from memory.\n`);
		},
	});
}
