/**
 * Quick smoke test: connect to an MCP filesystem server via stdio using the
 * same SDK calls as the pi extension. Run with:
 *   npx tsx scripts/test-mcp-connect.ts
 *
 * This intentionally does NOT load pi; it only verifies our understanding of
 * the MCP TS SDK API is correct.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
	const targetDir = process.argv[2] ?? process.cwd();

	const transport = new StdioClientTransport({
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem", targetDir],
		env: { ...getDefaultEnvironment() },
		stderr: "pipe",
	});

	transport.stderr?.on("data", (chunk: Buffer) => {
		process.stderr.write(`[server stderr] ${chunk.toString()}`);
	});

	const client = new Client(
		{ name: "pi-mcp-smoketest", version: "0.0.1" },
		{ capabilities: {} },
	);

	console.log("[test] connecting...");
	await client.connect(transport);

	console.log("[test] server version:", client.getServerVersion());
	console.log("[test] server capabilities:", client.getServerCapabilities());

	const tools = await client.listTools();
	console.log(`[test] tools (${tools.tools.length}):`);
	for (const t of tools.tools) {
		console.log(`  - ${t.name}: ${t.description ?? "(no description)"}`);
	}

	// Try calling list_directory on the target dir if the tool exists.
	const listTool = tools.tools.find((t) => t.name === "list_directory");
	if (listTool) {
		console.log(`[test] calling list_directory({ path: "${targetDir}" })...`);
		const result = await client.callTool({
			name: "list_directory",
			arguments: { path: targetDir },
		});
		console.log("[test] result:", JSON.stringify(result, null, 2).slice(0, 2000));
	}

	await transport.close();
	console.log("[test] done.");
}

main().catch((err) => {
	console.error("[test] error:", err);
	process.exit(1);
});
