/**
 * MCP Extension for Pi — Mount MCP servers as pi tools/commands/resources.
 *
 * Phase 1 feature set:
 * - Loads server config from `~/.pi/mcp.json` and `<cwd>/.pi/mcp.json`
 * - Supports stdio and Streamable HTTP transports
 * - On session_start, connects to each configured server, lists its tools,
 *   prompts, and resources; registers them with pi.
 * - Tool calls are forwarded to MCP client.callTool() and results converted to
 *   pi's TextContent/ImageContent shape.
 * - Tools/prompts/resources automatically refresh on list_changed notifications
 *   (via SDK's listChanged handlers).
 * - MCP prompts are exposed as `/mcp-prompt-<server>-<name>` slash commands.
 * - MCP resources are readable via a synthetic tool `mcp__<server>__read_resource`
 *   that wraps client.readResource().
 * - Commands: /mcp-list, /mcp-reload for inspection.
 *
 * Config format (JSON):
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/project"]
 *     },
 *     "remote-example": {
 *       "url": "http://localhost:3000/mcp",
 *       "headers": { "Authorization": "Bearer xxx" }
 *     }
 *   }
 * }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	type Prompt,
	PromptListChangedNotificationSchema,
	type Resource,
	ResourceListChangedNotificationSchema,
	type ResourceTemplate,
	type Tool,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type TSchema, Type } from "typebox";

// ============================================================================
// Config loading
// ============================================================================

interface StdioServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

interface HttpServerConfig {
	url: string;
	headers?: Record<string, string>;
}

type ServerConfig = (StdioServerConfig | HttpServerConfig) & {
	disabled?: boolean;
};

interface McpConfig {
	mcpServers: Record<string, ServerConfig>;
}

function isStdioConfig(cfg: ServerConfig): cfg is StdioServerConfig {
	return "command" in cfg && typeof (cfg as StdioServerConfig).command === "string";
}

function isHttpConfig(cfg: ServerConfig): cfg is HttpServerConfig {
	return "url" in cfg && typeof (cfg as HttpServerConfig).url === "string";
}

function loadConfig(cwd: string): McpConfig {
	const globalPath = join(homedir(), ".pi", "mcp.json");
	const projectPath = join(cwd, ".pi", "mcp.json");

	let merged: McpConfig = { mcpServers: {} };

	for (const path of [globalPath, projectPath]) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf-8"));
			if (raw && typeof raw === "object" && raw.mcpServers && typeof raw.mcpServers === "object") {
				merged = {
					mcpServers: { ...merged.mcpServers, ...raw.mcpServers },
				};
			}
		} catch (error: unknown) {
			// eslint-disable-next-line no-console
			console.warn(`[mcp] failed to load ${path}: ${errorMessage(error)}`);
		}
	}

	return merged;
}

// ============================================================================
// JSON Schema (MCP) → TypeBox schema
// ============================================================================

function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
	return Type.Unsafe({ ...schema });
}

// ============================================================================
// MCP content → pi content
// ============================================================================

type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "audio"; data: string; mimeType: string }
	| { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
	| { type: "resource_link"; uri: string; name: string; description?: string };

function convertContent(blocks: McpContentBlock[]): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				out.push({ type: "text", text: block.text });
				break;
			case "image":
				out.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "audio":
				out.push({
					type: "text",
					text: `[audio content, mime=${block.mimeType}, ${block.data.length} chars base64]`,
				});
				break;
			case "resource":
				if (block.resource.text !== undefined) {
					out.push({
						type: "text",
						text: `[resource ${block.resource.uri}${block.resource.mimeType ? ` (${block.resource.mimeType})` : ""}]\n${block.resource.text}`,
					});
				} else if (block.resource.blob !== undefined) {
					out.push({
						type: "text",
						text: `[resource ${block.resource.uri}${block.resource.mimeType ? ` (${block.resource.mimeType})` : ""}: binary blob, ${block.resource.blob.length} chars base64]`,
					});
				}
				break;
			case "resource_link":
				out.push({
					type: "text",
					text: `[resource link] ${block.name} — ${block.uri}${block.description ? `\n${block.description}` : ""}`,
				});
				break;
			default:
				out.push({ type: "text", text: `[unsupported MCP content block: ${JSON.stringify(block).slice(0, 500)}]` });
		}
	}
	return out;
}

// ============================================================================
// Sanitize MCP entity names into pi-safe identifiers (tools/commands)
// ============================================================================

function sanitizeIdComponent(raw: string): string {
	// Pi tool/command names allow alphanumerics, underscore, dash.
	return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function makeToolName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeIdComponent(serverName)}__${sanitizeIdComponent(toolName)}`;
}

function makeCommandName(serverName: string, promptName: string): string {
	return `mcp-prompt-${sanitizeIdComponent(serverName)}-${sanitizeIdComponent(promptName)}`;
}

// ============================================================================
// Server connection + tool/prompt/resource registration
// ============================================================================

type ServerTransport = Transport & { close?: () => Promise<void> | void };

interface ConnectedServer {
	name: string;
	client: Client;
	transport: ServerTransport;
	tools: Tool[];
	prompts: Prompt[];
	resources: Resource[];
	resourceTemplates: ResourceTemplate[];
	registeredToolNames: Set<string>;
	registeredCommandNames: Set<string>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function listAllTools(client: Client): Promise<Tool[]> {
	const tools: Tool[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

async function listAllPrompts(client: Client): Promise<Prompt[]> {
	const prompts: Prompt[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listPrompts(cursor ? { cursor } : undefined, { timeout: 15_000 });
		prompts.push(...page.prompts);
		cursor = page.nextCursor;
	} while (cursor);
	return prompts;
}

async function listAllResources(client: Client): Promise<Resource[]> {
	const resources: Resource[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listResources(cursor ? { cursor } : undefined, { timeout: 15_000 });
		resources.push(...page.resources);
		cursor = page.nextCursor;
	} while (cursor);
	return resources;
}

async function listAllResourceTemplates(client: Client): Promise<ResourceTemplate[]> {
	const templates: ResourceTemplate[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listResourceTemplates(cursor ? { cursor } : undefined, { timeout: 15_000 });
		templates.push(...page.resourceTemplates);
		cursor = page.nextCursor;
	} while (cursor);
	return templates;
}

function syncActiveTools(pi: ExtensionAPI, previous: ReadonlySet<string>, current: ReadonlySet<string>): void {
	const activeTools = new Set(pi.getActiveTools());
	for (const toolName of previous) {
		if (!current.has(toolName)) activeTools.delete(toolName);
	}
	for (const toolName of current) activeTools.add(toolName);
	pi.setActiveTools([...activeTools]);
}

async function connectStdioServer(
	name: string,
	cfg: StdioServerConfig,
): Promise<{ transport: ServerTransport; close: () => Promise<void> }> {
	const env: Record<string, string> = {
		...getDefaultEnvironment(),
		...(cfg.env ?? {}),
	};

	const transport = new StdioClientTransport({
		command: cfg.command,
		args: cfg.args ?? [],
		env,
		cwd: cfg.cwd,
		stderr: "pipe",
	});

	transport.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf-8").trimEnd();
		if (text) {
			// eslint-disable-next-line no-console
			console.warn(`[mcp:${name}] ${text.split("\n").join(`\n[mcp:${name}] `)}`);
		}
	});

	return { transport, close: () => transport.close() };
}

async function connectHttpServer(
	cfg: HttpServerConfig,
): Promise<{ transport: ServerTransport; close: () => Promise<void> }> {
	const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
		requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
	});
	// StreamableHTTPClientTransport provides onclose/onerror but no explicit close()? It does:
	return { transport, close: () => transport.close() };
}

function registerServerTools(pi: ExtensionAPI, server: ConnectedServer) {
	// There's no public unregisterTool(); re-registering replaces definitions
	// with the same names after a listChanged notification.
	server.registeredToolNames.clear();

	for (const tool of server.tools) {
		const prefixed = makeToolName(server.name, tool.name);
		server.registeredToolNames.add(prefixed);

		const parameters = jsonSchemaToTypeBox(tool.inputSchema as Record<string, unknown>);

		pi.registerTool({
			name: prefixed,
			label: `mcp:${server.name}/${tool.name}`,
			description: tool.description ?? `MCP tool ${tool.name} from ${server.name}`,
			promptSnippet: tool.description
				? `${tool.name} (from ${server.name} MCP server): ${tool.description.slice(0, 200)}`
				: undefined,
			parameters,
			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				try {
					const result = await server.client.callTool(
						{
							name: tool.name,
							arguments: params as Record<string, unknown>,
						},
						undefined,
						{ signal, timeout: 60_000, maxTotalTimeout: 120_000, resetTimeoutOnProgress: true },
					);

					const blocks = (result.content as McpContentBlock[] | undefined) ?? [];
					const mcpIsError = !!result.isError;

					const content = convertContent(blocks);
					if (content.length === 0) {
						content.push({ type: "text", text: `[mcp:${server.name}/${tool.name}] (no content returned)` });
					}

					if (mcpIsError) {
						content.unshift({
							type: "text",
							text: `[mcp:${server.name}/${tool.name}] tool returned an error:`,
						});
					}

					return {
						content,
						details: {
							server: server.name,
							tool: tool.name,
							isError: mcpIsError,
							structuredContent: result.structuredContent,
						},
					};
				} catch (error: unknown) {
					throw new Error(`[mcp:${server.name}/${tool.name}] ${errorMessage(error)}`, { cause: error });
				}
			},
		});
	}
}

function registerResourceAccessTool(pi: ExtensionAPI, server: ConnectedServer) {
	// Expose a single synthetic tool that can read any of the server's resources.
	// Resources are listed in the description so the LLM knows available URIs.
	const toolName = makeToolName(server.name, "read_resource");
	const resourceList =
		server.resources.length > 0
			? server.resources.map((r) => `- ${r.uri}  ${r.description ?? r.name ?? ""}`).join("\n")
			: "(server did not advertise any resources)";
	const templateList =
		server.resourceTemplates.length > 0
			? server.resourceTemplates
					.map((template) => `- ${template.uriTemplate}  ${template.description ?? template.name}`)
					.join("\n")
			: "(server did not advertise any resource templates)";

	pi.registerTool({
		name: toolName,
		label: `mcp:${server.name}/read_resource`,
		description: `Read a resource from MCP server "${server.name}" by URI. URI templates are accepted after substituting their variables.\n\nAvailable resources:\n${resourceList}\n\nResource templates:\n${templateList}`,
		promptSnippet: `Read resource from ${server.name} MCP server by URI`,
		parameters: Type.Object({
			uri: Type.String({ description: "Resource URI to read" }),
		}),
		async execute(_callId, params, signal) {
			try {
				const result = await server.client.readResource(
					{ uri: String(params.uri) },
					{ signal, timeout: 30_000, maxTotalTimeout: 60_000 },
				);
				const blocks: McpContentBlock[] = result.contents.map((c) => {
					if ("text" in c) {
						return { type: "resource", resource: { uri: c.uri, text: c.text, mimeType: c.mimeType } };
					}
					return { type: "resource", resource: { uri: c.uri, blob: c.blob, mimeType: c.mimeType } };
				});
				return {
					content: convertContent(blocks),
					details: { server: server.name, tool: "read_resource" },
				};
			} catch (error: unknown) {
				throw new Error(`[mcp:${server.name}/read_resource] ${errorMessage(error)}`, { cause: error });
			}
		},
	});
	server.registeredToolNames.add(toolName);
}

function registerPromptCommands(pi: ExtensionAPI, server: ConnectedServer) {
	const previousCommandNames = new Set(server.registeredCommandNames);
	server.registeredCommandNames.clear();

	for (const prompt of server.prompts) {
		const cmd = makeCommandName(server.name, prompt.name);
		server.registeredCommandNames.add(cmd);
		previousCommandNames.delete(cmd);
		const argNames: string[] = (prompt.arguments ?? []).map((a) => a.name);

		pi.registerCommand(cmd, {
			description: `[MCP:${server.name}] ${prompt.description ?? `Run prompt "${prompt.name}"`}${
				argNames.length ? ` (args: ${argNames.join(", ")})` : ""
			}`,
			handler: async (args, ctx) => {
				try {
					// args is the raw string after the command; split on whitespace to map positional
					// arguments to prompt.arguments[]. For key=value forms, parse those too.
					const promptArgs: Record<string, string> = {};
					const tokens = args.trim().split(/\s+/).filter(Boolean);
					if (prompt.arguments) {
						for (let i = 0; i < prompt.arguments.length && i < tokens.length; i++) {
							promptArgs[prompt.arguments[i].name] = tokens[i];
						}
						// Also accept key=value pairs to override.
						for (const tok of tokens) {
							const eq = tok.indexOf("=");
							if (eq > 0) promptArgs[tok.slice(0, eq)] = tok.slice(eq + 1);
						}
					}

					const result = await server.client.getPrompt({ name: prompt.name, arguments: promptArgs });
					const lines: string[] = [`[mcp-prompt:${server.name}/${prompt.name}]`];
					for (const msg of result.messages ?? []) {
						const role = msg.role;
						const content = msg.content;
						if (content.type === "text") {
							lines.push(`<${role}>\n${content.text}`);
						} else if (content.type === "resource") {
							lines.push(`<${role}> [resource ${content.resource.uri}]`);
						} else {
							lines.push(`<${role}> [${content.type}]`);
						}
					}

					// Inject the assembled prompt as a user message so the agent responds to it.
					ctx.ui.notify(lines.join("\n"), "info");
					pi.sendUserMessage(lines.join("\n\n"));
				} catch (error: unknown) {
					ctx.ui.notify(`[mcp] failed to get prompt "${prompt.name}": ${errorMessage(error)}`, "error");
				}
			},
		});
	}

	for (const commandName of previousCommandNames) {
		pi.registerCommand(commandName, {
			description: `[MCP:${server.name}] prompt removed by the server`,
			handler: async (_args, ctx) => {
				ctx.ui.notify(`MCP prompt /${commandName} is no longer advertised by ${server.name}.`, "warning");
			},
		});
	}
}

async function connectServer(name: string, cfg: ServerConfig): Promise<ConnectedServer> {
	const { transport } = isHttpConfig(cfg) ? await connectHttpServer(cfg) : await connectStdioServer(name, cfg);

	const client = new Client(
		{ name: "pi-mcp-extension", version: "0.0.1" },
		{
			capabilities: {},
		},
	);

	await client.connect(transport);

	let tools: Tool[] = [];
	let prompts: Prompt[] = [];
	let resources: Resource[] = [];
	let resourceTemplates: ResourceTemplate[] = [];

	const caps = client.getServerCapabilities() ?? {};

	if (caps.tools) {
		tools = await listAllTools(client);
	}
	if (caps.prompts) {
		try {
			prompts = await listAllPrompts(client);
		} catch {
			/* prompts not supported */
		}
	}
	if (caps.resources) {
		try {
			resources = await listAllResources(client);
			try {
				resourceTemplates = await listAllResourceTemplates(client);
			} catch {
				resourceTemplates = [];
			}
		} catch {
			/* resources not supported */
		}
	}

	return {
		name,
		client,
		transport,
		tools,
		prompts,
		resources,
		resourceTemplates,
		registeredToolNames: new Set(),
		registeredCommandNames: new Set(),
	};
}

function wireListChangedHandlers(pi: ExtensionAPI, server: ConnectedServer) {
	const caps = server.client.getServerCapabilities() ?? {};
	// Re-create the client with listChanged handlers? The SDK Client reads
	// `listChanged` from constructor options at connect() time, so we cannot
	// retrofit it after connect. Instead, fall back to registering raw
	// notification handlers via the transport-level onmessage.
	//
	// Simpler & robust: set up a periodic "reload on notification" handler by
	// hooking into client.setNotificationHandler if available.
	//
	// The SDK Client exposes `setNotificationHandler` via Protocol base class.
	const refreshTools = async () => {
		try {
			server.tools = await listAllTools(server.client);
			registerServerAll(pi, server);
			// eslint-disable-next-line no-console
			console.warn(`[mcp:${server.name}] tools refreshed: ${server.tools.length}`);
		} catch (error: unknown) {
			// eslint-disable-next-line no-console
			console.warn(`[mcp:${server.name}] failed to refresh tools: ${errorMessage(error)}`);
		}
	};
	const refreshPrompts = async () => {
		try {
			server.prompts = await listAllPrompts(server.client);
			registerPromptCommands(pi, server);
		} catch {
			/* ignore */
		}
	};
	const refreshResources = async () => {
		try {
			server.resources = await listAllResources(server.client);
			try {
				server.resourceTemplates = await listAllResourceTemplates(server.client);
			} catch {
				server.resourceTemplates = [];
			}
			registerServerAll(pi, server);
		} catch {
			/* ignore */
		}
	};

	try {
		if (caps.tools?.listChanged) {
			server.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				await refreshTools();
			});
		}
		if (caps.prompts?.listChanged) {
			server.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
				await refreshPrompts();
			});
		}
		if (caps.resources?.listChanged) {
			server.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
				await refreshResources();
			});
		}
	} catch {
		/* If the SDK shape differs, list_changed just won't auto-refresh. */
	}
}

function registerServerAll(pi: ExtensionAPI, server: ConnectedServer) {
	const previousToolNames = new Set(server.registeredToolNames);
	registerServerTools(pi, server);
	registerResourceAccessTool(pi, server);
	registerPromptCommands(pi, server);
	syncActiveTools(pi, previousToolNames, server.registeredToolNames);
}

// ============================================================================
// Extension entrypoint
// ============================================================================

export default async function mcpExtension(pi: ExtensionAPI) {
	const servers: ConnectedServer[] = [];

	async function shutdownAll() {
		for (const server of servers) {
			syncActiveTools(pi, server.registeredToolNames, new Set());
			try {
				if (typeof server.transport.close === "function") {
					await server.transport.close();
				}
			} catch {
				/* ignore */
			}
		}
		servers.length = 0;
	}

	pi.on("session_start", async (_event, ctx) => {
		await shutdownAll();
		const config = loadConfig(ctx.cwd);
		const entries = Object.entries(config.mcpServers);

		if (entries.length === 0) {
			ctx.ui.setStatus("mcp", "MCP: no servers configured");
			return;
		}

		let connected = 0;
		let failed = 0;
		let totalTools = 0;
		let totalPrompts = 0;

		for (const [name, cfg] of entries) {
			if (cfg.disabled) continue;

			if (!isStdioConfig(cfg) && !isHttpConfig(cfg)) {
				ctx.ui.notify(`[mcp] server "${name}": unsupported config (need "command" or "url"), skipping`, "warning");
				continue;
			}

			try {
				ctx.ui.setStatus("mcp", `MCP: connecting ${name}...`);
				const server = await connectServer(name, cfg);
				registerServerAll(pi, server);
				wireListChangedHandlers(pi, server);
				servers.push(server);
				connected += 1;
				totalTools += server.tools.length;
				totalPrompts += server.prompts.length;
			} catch (error: unknown) {
				failed += 1;
				ctx.ui.notify(`[mcp] failed to connect "${name}": ${errorMessage(error)}`, "error");
			}
		}

		ctx.ui.setStatus(
			"mcp",
			`MCP: ${connected} server(s), ${totalTools} tool(s), ${totalPrompts} prompt(s)${failed ? `, ${failed} failed` : ""}`,
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await shutdownAll();
		ctx.ui.setStatus("mcp", undefined);
	});

	// ---- Commands ---------------------------------------------------------

	pi.registerCommand("mcp-list", {
		description: "List connected MCP servers and their tools/prompts/resources",
		handler: async (_args, ctx) => {
			if (servers.length === 0) {
				ctx.ui.notify("No MCP servers connected.", "info");
				return;
			}
			const lines: string[] = [];
			for (const s of servers) {
				const version = s.client.getServerVersion();
				const caps = s.client.getServerCapabilities();
				lines.push(
					`• ${s.name}  ${version ? `(${version.name} ${version.version ?? ""})` : ""}  caps=${Object.keys(caps ?? {}).join(",") || "(none)"}`,
				);
				if (s.tools.length) {
					lines.push(`    tools (${s.tools.length}):`);
					for (const t of s.tools) {
						lines.push(
							`      - ${makeToolName(s.name, t.name)}  ${t.description ? `— ${(t.description ?? "").slice(0, 120)}` : ""}`,
						);
					}
				}
				if (s.prompts.length) {
					lines.push(`    prompts (${s.prompts.length}):`);
					for (const p of s.prompts) {
						lines.push(
							`      - /${makeCommandName(s.name, p.name)}  ${p.description ? `— ${(p.description ?? "").slice(0, 120)}` : ""}`,
						);
					}
				}
				if (s.resources.length) {
					lines.push(`    resources (${s.resources.length}):`);
					for (const r of s.resources) {
						lines.push(`      - ${r.uri}  ${r.description ? `— ${(r.description ?? "").slice(0, 100)}` : ""}`);
					}
				}
				if (s.resourceTemplates.length) {
					lines.push(`    resource templates (${s.resourceTemplates.length}):`);
					for (const template of s.resourceTemplates) {
						lines.push(
							`      - ${template.uriTemplate}  ${template.description ? `— ${template.description.slice(0, 100)}` : ""}`,
						);
					}
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("mcp-reload", {
		description: "Reconnect to all configured MCP servers",
		handler: async (_args, ctx) => {
			await shutdownAll();

			const config = loadConfig(ctx.cwd);
			let connected = 0;
			let totalTools = 0;
			let totalPrompts = 0;
			for (const [name, cfg] of Object.entries(config.mcpServers)) {
				if (cfg.disabled) continue;
				if (!isStdioConfig(cfg) && !isHttpConfig(cfg)) continue;
				try {
					const server = await connectServer(name, cfg);
					registerServerAll(pi, server);
					wireListChangedHandlers(pi, server);
					servers.push(server);
					connected += 1;
					totalTools += server.tools.length;
					totalPrompts += server.prompts.length;
				} catch (error: unknown) {
					ctx.ui.notify(`[mcp] failed to connect "${name}": ${errorMessage(error)}`, "error");
				}
			}

			ctx.ui.notify(
				`MCP reloaded: ${connected} server(s), ${totalTools} tool(s), ${totalPrompts} prompt(s)`,
				"info",
			);
			ctx.ui.setStatus("mcp", `MCP: ${connected} server(s), ${totalTools} tool(s), ${totalPrompts} prompt(s)`);
		},
	});
}
