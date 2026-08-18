import { createInterface } from "node:readline";

const protocolVersion = "2026-07-28";

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isModernRequest(value: unknown): value is {
	id: string | number;
	method: string;
	params: { _meta?: Record<string, unknown>; name?: string };
} {
	return typeof value === "object" && value !== null && "id" in value && "method" in value && "params" in value;
}

function hasRequiredMetadata(params: { _meta?: Record<string, unknown> }): boolean {
	return (
		params._meta?.["io.modelcontextprotocol/protocolVersion"] === protocolVersion &&
		typeof params._meta?.["io.modelcontextprotocol/clientInfo"] === "object" &&
		typeof params._meta?.["io.modelcontextprotocol/clientCapabilities"] === "object"
	);
}

const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
input.on("line", (line) => {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (!isModernRequest(message)) return;
	if (!hasRequiredMetadata(message.params)) {
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Missing 2026-07-28 metadata" } });
		return;
	}

	switch (message.method) {
		case "server/discover":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					resultType: "complete",
					supportedVersions: [protocolVersion],
					capabilities: { tools: { listChanged: true } },
					ttlMs: 60_000,
					cacheScope: "public",
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "pi-modern-test", version: "1.0.0" } },
				},
			});
			break;
		case "tools/list":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					resultType: "complete",
					tools: [
						{
							name: "read_fixture",
							description: "Read the modern MCP fixture.",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
					ttlMs: 60_000,
					cacheScope: "public",
				},
			});
			break;
		case "tools/call":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { resultType: "complete", content: [{ type: "text", text: "modern MCP fixture response" }] },
			});
			break;
		case "subscriptions/listen":
			send({
				jsonrpc: "2.0",
				method: "notifications/subscriptions/acknowledged",
				params: { _meta: { "io.modelcontextprotocol/subscriptionId": message.id } },
			});
			break;
		default:
			send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
	}
});
