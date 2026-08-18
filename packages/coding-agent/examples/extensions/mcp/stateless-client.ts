import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	isJSONRPCErrorResponse,
	isJSONRPCNotification,
	isJSONRPCResultResponse,
	type JSONRPCMessage,
	type JSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";

const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

type JsonObject = Record<string, unknown>;
type RequestOptions = { timeout?: number; signal?: AbortSignal } | undefined;
type PendingRequest = {
	resolve: (result: JsonObject) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

export interface ModernServerInfo {
	name: string;
	version: string;
	websiteUrl?: string;
	description?: string;
	icons?: unknown[];
}

export interface ModernServerDiscovery {
	supportedVersions: string[];
	capabilities: JsonObject;
	serverInfo?: ModernServerInfo;
	instructions?: string;
}

export interface ModernNotification {
	method: string;
	params?: JsonObject;
}

export class ModernMcpError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "ModernMcpError";
		this.code = code;
		this.data = data;
	}
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultObject(response: JSONRPCResultResponse): JsonObject {
	return isObject(response.result) ? response.result : {};
}

function responseError(response: { error: { code: number; message: string; data?: unknown } }): ModernMcpError {
	return new ModernMcpError(response.error.code, response.error.message, response.error.data);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Client for the 2026-07-28 stateless protocol. The SDK transport is still
 * used for framing, subprocess management, HTTP SSE parsing, and auth; only
 * the removed initialize/session layer is implemented here.
 */
export class StatelessMcpClient {
	private readonly clientInfo: { name: string; version: string };
	private readonly clientCapabilities: JsonObject;
	private readonly pending = new Map<string | number, PendingRequest>();
	private readonly notificationHandlers = new Map<
		string,
		Set<(notification: ModernNotification) => void | Promise<void>>
	>();
	private nextRequestId = 1;
	private started = false;
	private protocolVersion = MODERN_PROTOCOL_VERSION;
	private serverCapabilities: JsonObject = {};
	private serverInfo?: ModernServerInfo;
	private instructions?: string;

	constructor(clientInfo: { name: string; version: string }, clientCapabilities: JsonObject = {}) {
		this.clientInfo = clientInfo;
		this.clientCapabilities = clientCapabilities;
	}

	async connect(transport: Transport): Promise<void> {
		if (this.started) throw new Error("MCP client is already connected");
		this.transport = transport;
		transport.onmessage = (message) => this.handleMessage(message);
		transport.onerror = (error) => this.failPending(error);
		transport.onclose = () => this.failPending(new Error("MCP transport closed"));
		await transport.start();
		this.started = true;
	}

	async close(transport: Transport): Promise<void> {
		this.failPending(new Error("MCP client closed"));
		this.started = false;
		await transport.close();
		this.transport = undefined;
	}

	getServerCapabilities(): JsonObject {
		return this.serverCapabilities;
	}

	getServerVersion(): ModernServerInfo | undefined {
		return this.serverInfo;
	}

	getInstructions(): string | undefined {
		return this.instructions;
	}

	getProtocolVersion(): string {
		return this.protocolVersion;
	}

	onNotification(method: string, handler: (notification: ModernNotification) => void | Promise<void>): () => void {
		const handlers = this.notificationHandlers.get(method) ?? new Set();
		handlers.add(handler);
		this.notificationHandlers.set(method, handlers);
		return () => handlers.delete(handler);
	}

	async discover(options?: RequestOptions): Promise<ModernServerDiscovery> {
		let result: JsonObject;
		try {
			result = await this.request("server/discover", {}, options);
		} catch (error: unknown) {
			if (!(error instanceof ModernMcpError) || error.code !== -32022 || !isObject(error.data)) throw error;
			const supported = Array.isArray(error.data.supported)
				? error.data.supported.filter((value): value is string => typeof value === "string")
				: [];
			const selected = supported.find((version) => version === MODERN_PROTOCOL_VERSION);
			if (!selected) throw error;
			this.protocolVersion = selected;
			result = await this.request("server/discover", {}, options);
		}

		const supportedVersions = Array.isArray(result.supportedVersions)
			? result.supportedVersions.filter((value): value is string => typeof value === "string")
			: [];
		if (!supportedVersions.includes(this.protocolVersion)) {
			const selected = supportedVersions.find((version) => version === MODERN_PROTOCOL_VERSION);
			if (!selected) throw new Error("MCP server does not advertise 2026-07-28 support");
			this.protocolVersion = selected;
			result = await this.request("server/discover", {}, options);
		}
		this.serverCapabilities = isObject(result.capabilities) ? result.capabilities : {};
		const serverInfo = isObject(result._meta) ? result._meta[SERVER_INFO_META] : undefined;
		this.serverInfo =
			isObject(serverInfo) && typeof serverInfo.name === "string" && typeof serverInfo.version === "string"
				? {
						name: serverInfo.name,
						version: serverInfo.version,
						websiteUrl: typeof serverInfo.websiteUrl === "string" ? serverInfo.websiteUrl : undefined,
						description: typeof serverInfo.description === "string" ? serverInfo.description : undefined,
						icons: Array.isArray(serverInfo.icons) ? serverInfo.icons : undefined,
					}
				: undefined;
		this.instructions = typeof result.instructions === "string" ? result.instructions : undefined;
		return {
			supportedVersions,
			capabilities: this.serverCapabilities,
			serverInfo: this.serverInfo,
			instructions: this.instructions,
		};
	}

	async request(method: string, params: JsonObject = {}, options?: RequestOptions): Promise<JsonObject> {
		if (!this.started) throw new Error("MCP client is not connected");
		const id = this.nextRequestId++;
		const requestParams: JsonObject = {
			...params,
			_meta: {
				...(isObject(params._meta) ? params._meta : {}),
				[PROTOCOL_VERSION_META]: this.protocolVersion,
				[CLIENT_INFO_META]: this.clientInfo,
				[CLIENT_CAPABILITIES_META]: this.clientCapabilities,
			},
		};
		const request = { jsonrpc: "2.0" as const, id, method, params: requestParams };
		const timeoutMs = options?.timeout ?? 60_000;
		return new Promise<JsonObject>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			void this.send(request, options?.signal).catch((error: unknown) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timeout);
				pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
			});
		});
	}

	async listTools(params: { cursor?: string } = {}, options?: RequestOptions) {
		return this.request("tools/list", params, options) as Promise<{ tools: unknown[]; nextCursor?: string }>;
	}

	async listPrompts(params: { cursor?: string } = {}, options?: RequestOptions) {
		return this.request("prompts/list", params, options) as Promise<{ prompts: unknown[]; nextCursor?: string }>;
	}

	async listResources(params: { cursor?: string } = {}, options?: RequestOptions) {
		return this.request("resources/list", params, options) as Promise<{ resources: unknown[]; nextCursor?: string }>;
	}

	async listResourceTemplates(params: { cursor?: string } = {}, options?: RequestOptions) {
		return this.request("resources/templates/list", params, options) as Promise<{
			resourceTemplates: unknown[];
			nextCursor?: string;
		}>;
	}

	async callTool(params: JsonObject, _resultSchema?: unknown, options?: RequestOptions): Promise<JsonObject> {
		return this.request("tools/call", params, options);
	}

	async readResource(params: { uri: string }, options?: RequestOptions): Promise<{ contents: unknown[] }> {
		return this.request("resources/read", params, options) as Promise<{ contents: unknown[] }>;
	}

	async getPrompt(
		params: { name: string; arguments?: Record<string, string> },
		options?: RequestOptions,
	): Promise<{ messages: unknown[] }> {
		return this.request("prompts/get", params, options) as Promise<{ messages: unknown[] }>;
	}

	async subscribe(notifications: JsonObject): Promise<void> {
		if (!this.started) return;
		const requestParams: JsonObject = {
			notifications,
			_meta: {
				[PROTOCOL_VERSION_META]: this.protocolVersion,
				[CLIENT_INFO_META]: this.clientInfo,
				[CLIENT_CAPABILITIES_META]: this.clientCapabilities,
			},
		};
		await this.send({
			jsonrpc: "2.0",
			id: this.nextRequestId++,
			method: "subscriptions/listen",
			params: requestParams,
		});
	}

	private async send(message: JSONRPCMessage, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("MCP request aborted");
		const transport = this.transport;
		if (!transport) throw new Error("MCP transport is not available");
		await transport.send(message);
	}

	private transport?: Transport;

	private handleMessage(message: JSONRPCMessage): void {
		if (isJSONRPCResultResponse(message)) {
			if (message.id === undefined) return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timeout);
			const result = resultObject(message);
			const resultType = result.resultType;
			if (resultType === "input_required") {
				pending.reject(new Error("MCP server requested unsupported multi-round-trip input"));
				return;
			}
			if (resultType !== undefined && resultType !== "complete") {
				pending.reject(new Error(`Unsupported MCP result type: ${String(resultType)}`));
				return;
			}
			pending.resolve(result);
			return;
		}
		if (isJSONRPCErrorResponse(message)) {
			if (message.id === undefined) return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timeout);
			pending.reject(responseError(message));
			return;
		}
		if (isJSONRPCNotification(message)) {
			const notification: ModernNotification = {
				method: message.method,
				params: isObject(message.params) ? message.params : undefined,
			};
			for (const handler of this.notificationHandlers.get(message.method) ?? []) {
				Promise.resolve(handler(notification)).catch(() => undefined);
			}
		}
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
