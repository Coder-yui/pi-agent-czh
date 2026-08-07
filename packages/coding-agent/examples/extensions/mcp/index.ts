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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Prompt, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "typebox";

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
		} catch (err: any) {
			// eslint-disable-next-line no-console
			console.warn(`[mcp] failed to load ${path}: ${err.message}`);
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
				out.push({ type: "text", text: `[audio content, mime=${block.mimeType}, ${block.data.length} chars base64]` });
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
	registeredToolNames: Set<string>;
	registeredCommandNames: Set<string>;
}

async function connectStdioServer(name: string, cfg: StdioServerConfig): Promise<{ transport: ServerTransport; close: () => Promise<void> }> {
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
	name: string,
	cfg: HttpServerConfig,
): Promise<{ transport: ServerTransport; close: () => Promise<void> }> {
	const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
		requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
	});
	// StreamableHTTPClientTransport provides onclose/onerror but no explicit close()? It does:
	return { transport, close: () => transport.close() };
}

function registerServerTools(pi: ExtensionAPI, server: ConnectedServer) {
	// Clean out previously-registered tools from a prior listChanged refresh.
	for (const existing of server.registeredToolNames) {
		// There's no public unregisterTool(); pi keeps the latest definition if
		// we re-register with the same name, which is good enough for refresh.
	}
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
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				try {
					const result = await server.client.callTool({
						name: tool.name,
						arguments: params as Record<string, unknown>,
					});

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
				} catch (err: any) {
					throw new Error(`[mcp:${server.name}/${tool.name}] ${err?.message ?? String(err)}`);
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

	pi.registerTool({
		name: toolName,
		label: `mcp:${server.name}/read_resource`,
		description: `Read a resource from MCP server "${server.name}" by URI.\n\nAvailable resources:\n${resourceList}`,
		promptSnippet: `Read resource from ${server.name} MCP server by URI`,
		parameters: Type.Object({
			uri: Type.String({ description: "Resource URI to read" }),
		}),
		async execute(_callId, params) {
			try {
				const result = await server.client.readResource({ uri: String(params.uri) });
				const blocks: McpContentBlock[] = (result.contents as any[]).map((c) => {
					if (c.text !== undefined) {
						return { type: "resource", resource: { uri: c.uri, text: c.text, mimeType: c.mimeType } };
					}
					if (c.blob !== undefined) {
						return { type: "resource", resource: { uri: c.uri, blob: c.blob, mimeType: c.mimeType } };
					}
					return { type: "text", text: `[empty resource ${c.uri}]` };
				});
				return {
					content: convertContent(blocks),
					details: { server: server.name, tool: "read_resource" },
				};
			} catch (err: any) {
				throw new Error(`[mcp:${server.name}/read_resource] ${err?.message ?? String(err)}`);
			}
		},
	});
	server.registeredToolNames.add(toolName);
}

function registerPromptCommands(pi: ExtensionAPI, server: ConnectedServer) {
	// Clean up previous commands (best-effort: re-registering overwrites).
	server.registeredCommandNames.clear();

	for (const prompt of server.prompts) {
		const cmd = makeCommandName(server.name, prompt.name);
		server.registeredCommandNames.add(cmd);
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
					await ctx.sendMessage({
						role: "user",
						content: [{ type: "text", text: lines.join("\n\n") }],
					});
				} catch (err: any) {
					ctx.ui.notify(`[mcp] failed to get prompt "${prompt.name}": ${err?.message ?? String(err)}`, "error");
				}
			},
		});
	}
}

async function connectServer(name: string, cfg: ServerConfig): Promise<ConnectedServer> {
	const { transport } = isHttpConfig(cfg)
		? await connectHttpServer(name, cfg)
		: await connectStdioServer(name, cfg);

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

	const caps = client.getServerCapabilities() ?? {};

	if (caps.tools) {
		const toolsResult = await client.listTools();
		tools = toolsResult.tools ?? [];
	}
	if (caps.prompts) {
		try {
			const promptsResult = await client.listPrompts();
			prompts = promptsResult.prompts ?? [];
		} catch {
			/* prompts not supported */
		}
	}
	if (caps.resources) {
		try {
			const resourcesResult = await client.listResources();
			resources = resourcesResult.resources ?? [];
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
			const r = await server.client.listTools();
			server.tools = r.tools ?? [];
			registerServerTools(pi, server);
			registerResourceAccessTool(pi, server);
			// eslint-disable-next-line no-console
			console.warn(`[mcp:${server.name}] tools refreshed: ${server.tools.length}`);
		} catch (err: any) {
			// eslint-disable-next-line no-console
			console.warn(`[mcp:${server.name}] failed to refresh tools: ${err?.message ?? err}`);
		}
	};
	const refreshPrompts = async () => {
		try {
			const r = await server.client.listPrompts();
			server.prompts = r.prompts ?? [];
			registerPromptCommands(pi, server);
		} catch {
			/* ignore */
		}
	};
	const refreshResources = async () => {
		try {
			const r = await server.client.listResources();
			server.resources = r.resources ?? [];
			registerResourceAccessTool(pi, server);
		} catch {
			/* ignore */
		}
	};

	try {
		// Methods on Protocol base (imported from SDK). We use dynamic method names
		// to stay tolerant of SDK version drift.
		const proto = Object.getPrototypeOf(server.client);
		const setNotif = proto.setNotificationHandler?.bind(server.client);
		if (setNotif && caps.tools?.listChanged) {
			setNotif({ method: "notifications/tools/list_changed" }, async () => {
				await refreshTools();
			});
		}
		if (setNotif && caps.prompts?.listChanged) {
			setNotif({ method: "notifications/prompts/list_changed" }, async () => {
				await refreshPrompts();
			});
		}
		if (setNotif && caps.resources?.listChanged) {
			setNotif({ method: "notifications/resources/list_changed" }, async () => {
				await refreshResources();
			});
		}
	} catch {
		/* If the SDK shape differs, list_changed just won't auto-refresh. */
	}
}

function registerServerAll(pi: ExtensionAPI, server: ConnectedServer) {
	registerServerTools(pi, server);
	registerResourceAccessTool(pi, server);
	registerPromptCommands(pi, server);
}

// ============================================================================
// Extension entrypoint
// ============================================================================

export default async function mcpExtension(pi: ExtensionAPI) {
	const servers: ConnectedServer[] = [];

	async function shutdownAll() {
		for (const server of servers) {
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
			} catch (err: any) {
				failed += 1;
				ctx.ui.notify(`[mcp] failed to connect "${name}": ${err?.message ?? String(err)}`, "error");
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
						lines.push(`      - ${makeToolName(s.name, t.name)}  ${t.description ? `— ${(t.description ?? "").slice(0, 120)}` : ""}`);
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
				} catch (err: any) {
					ctx.ui.notify(`[mcp] failed to connect "${name}": ${err?.message ?? String(err)}`, "error");
				}
			}

			ctx.ui.notify(`MCP reloaded: ${connected} server(s), ${totalTools} tool(s), ${totalPrompts} prompt(s)`, "info");
			ctx.ui.setStatus("mcp", `MCP: ${connected} server(s), ${totalTools} tool(s), ${totalPrompts} prompt(s)`);
		},
	});
}
