/**
 * End-to-end smoke test for the MCP extension.
 *
 * - Creates a pi AgentSession with the MCP extension loaded as an inline factory
 * - Triggers session_start (bindExtensions) so the MCP server connects
 * - Verifies that mcp__filesystem__* tools are registered
 * - Invokes one MCP tool via the session tool registry and checks the result
 *
 * Does NOT call the LLM — we only exercise the extension + tool wiring.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

// Locate coding-agent package root from this script's location.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CODING_AGENT_ROOT = join(__dirname, "../../../../");
const CORE_DIR = join(CODING_AGENT_ROOT, "src", "core");

const DefaultResourceLoader = (await import(join(CORE_DIR, "resource-loader.ts"))).DefaultResourceLoader;
const { createAgentSession } = await import(join(CORE_DIR, "sdk.ts"));
const { SessionManager } = await import(join(CORE_DIR, "session-manager.ts"));
const { SettingsManager } = await import(join(CORE_DIR, "settings-manager.ts"));
const mcpExtension = (await import(join(__dirname, "..", "index.ts"))).default;

async function main() {
	const tempDir = join(tmpdir(), `pi-mcp-e2e-${Date.now()}`);
	const agentDir = join(tempDir, "agent");
	const cwd = tempDir;
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	// Project-local MCP config — mount filesystem server scoped to cwd.
	writeFileSync(
		join(cwd, ".pi", "mcp.json"),
		JSON.stringify(
			{
				mcpServers: {
					filesystem: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem", cwd],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(join(cwd, "hello.txt"), "hello from pi-mcp-test\n");

	// Use faux provider so the test doesn't need any API key (we won't call LLM anyway).
	const faux = registerFauxProvider();
	const model = faux.getModel("faux-1")!;

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		// Pass extension directly as an inline factory (no settings-disk lookup needed).
		extensionFactories: [mcpExtension as any],
	});
	await resourceLoader.reload();

	console.log(`[test] cwd = ${cwd}`);
	console.log(
		`[test] discovered extensions:`,
		resourceLoader.getExtensions().extensions.map((e) => e.sourceInfo.path),
	);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		sessionManager,
		resourceLoader,
	});

	console.log(`[test] tools before bindExtensions: ${session.getAllTools().length}`);

	// Trigger session_start — our extension connects to MCP server here.
	// session_start is fired and awaited inside bindExtensions.
	await session.bindExtensions({});

	const allTools = session.agent.state.tools;
	console.log(`[test] tools after bindExtensions: ${allTools.length}`);

	const mcpTools = allTools.filter((t) => t.name.startsWith("mcp__"));
	console.log(`[test] MCP tools registered: ${mcpTools.length}`);
	for (const t of mcpTools) {
		console.log(`    - ${t.name}  (label=${t.label ?? "(no label)"})`);
	}

	if (mcpTools.length === 0) {
		throw new Error("No MCP tools were registered — extension may have failed to connect.");
	}

	// Pick the list_directory tool and actually invoke it.
	const listDir = mcpTools.find((t) => t.name === "mcp__filesystem__list_directory");
	if (!listDir) throw new Error("mcp__filesystem__list_directory not found");

	console.log(`[test] invoking ${listDir.name} with path=${cwd}`);
	const result = await listDir.execute("test-call", { path: cwd });
	console.log(`[test] tool result content:`);
	for (const block of result.content) {
		if (block.type === "text") {
			console.log(block.text);
		} else {
			console.log(JSON.stringify(block, null, 2));
		}
	}

	const textContent = result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	if (!textContent.includes("hello.txt")) {
		throw new Error(`Expected hello.txt in list_directory output, got:\n${textContent}`);
	}
	if ((result.details as any)?.isError) {
		throw new Error(`Tool reported MCP isError: ${JSON.stringify(result.details)}`);
	}

	session.dispose();

	// Cleanup temp dir
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}

	console.log("\n[test] ✅ MCP extension end-to-end test passed");
	faux.unregister();
}

main().catch((err) => {
	console.error("[test] ❌ FAILED:", err?.stack ?? err);
	process.exit(1);
});
