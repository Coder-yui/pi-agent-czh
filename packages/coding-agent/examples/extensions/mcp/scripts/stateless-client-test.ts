import { strict as assert } from "node:assert";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { MODERN_PROTOCOL_VERSION, StatelessMcpClient } from "../stateless-client.ts";

class MockTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	readonly sent: JSONRPCMessage[] = [];

	async start(): Promise<void> {}

	async close(): Promise<void> {
		this.onclose?.();
	}

	async send(message: JSONRPCMessage): Promise<void> {
		this.sent.push(message);
		if (!("id" in message) || message.id === undefined || !("method" in message)) return;
		if (message.method === "server/discover") {
			this.onmessage?.({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					resultType: "complete",
					supportedVersions: [MODERN_PROTOCOL_VERSION],
					capabilities: { tools: { listChanged: true } },
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "mock", version: "1.0.0" } },
				},
			});
		}
	}
}

async function main(): Promise<void> {
	const transport = new MockTransport();
	const client = new StatelessMcpClient({ name: "pi-mcp-test", version: "1.0.0" });
	await client.connect(transport);
	const discovery = await client.discover();
	assert.deepEqual(discovery.supportedVersions, [MODERN_PROTOCOL_VERSION]);
	assert.equal(discovery.serverInfo?.name, "mock");

	const discoverRequest = transport.sent[0];
	assert.ok("params" in discoverRequest && discoverRequest.params);
	const metadata = (discoverRequest.params as { _meta?: Record<string, unknown> })._meta;
	assert.equal(metadata?.["io.modelcontextprotocol/protocolVersion"], MODERN_PROTOCOL_VERSION);
	assert.deepEqual(metadata?.["io.modelcontextprotocol/clientCapabilities"], {});
	assert.deepEqual(metadata?.["io.modelcontextprotocol/clientInfo"], { name: "pi-mcp-test", version: "1.0.0" });

	let refreshed = false;
	client.onNotification("notifications/tools/list_changed", () => {
		refreshed = true;
	});
	await client.subscribe({ toolsListChanged: true });
	const subscription = transport.sent[1];
	assert.ok("method" in subscription && subscription.method === "subscriptions/listen");
	transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
	await Promise.resolve();
	assert.equal(refreshed, true);

	await client.close(transport);
	console.log("[test] stateless MCP client passed");
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
