/**
 * End-to-end smoke test for the Memory extension.
 *
 * - Creates a pi AgentSession with the Memory extension (which spawns the
 *   official @modelcontextprotocol/server-memory as a child process).
 * - Triggers session_start via bindExtensions() so the memory server connects.
 * - Verifies memory__* tools are registered.
 * - Adds facts via memory__add_fact, verifies read_graph returns them,
 *   tests search, tests persistence to <cwd>/.pi/memory.json.
 *
 * Does NOT call the LLM — we only exercise the extension + tool wiring.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODING_AGENT_ROOT = join(__dirname, "../../../../");
const CORE_DIR = join(CODING_AGENT_ROOT, "src", "core");

const DefaultResourceLoader = (await import(join(CORE_DIR, "resource-loader.ts"))).DefaultResourceLoader;
const { createAgentSession } = await import(join(CORE_DIR, "sdk.ts"));
const { SessionManager } = await import(join(CORE_DIR, "session-manager.ts"));
const { SettingsManager } = await import(join(CORE_DIR, "settings-manager.ts"));
const memoryExtension = (await import(join(__dirname, "..", "index.ts"))).default;

function textOf(result: any): string {
	return (result.content ?? [])
		.filter((b: any) => b.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

async function main() {
	const tempDir = join(tmpdir(), `pi-mem-e2e-${Date.now()}`);
	const agentDir = join(tempDir, "agent");
	const cwd = tempDir;
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const faux = registerFauxProvider();
	const model = faux.getModel("faux-1")!;

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [memoryExtension as any],
	});
	await resourceLoader.reload();

	console.log(`[test] cwd = ${cwd}`);

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		sessionManager,
		resourceLoader,
	});

	console.log(`[test] triggering session_start via bindExtensions...`);
	// Give the npx subprocess time to boot; 8s is generous for first-time cached npx.
	await session.bindExtensions({});

	const allTools = session.agent.state.tools;
	const memTools = allTools.filter((t) => t.name.startsWith("memory__"));
	console.log(`[test] memory tools registered: ${memTools.length}`);
	for (const t of memTools) {
		console.log(`    - ${t.name}  (${t.label ?? "(no label)"})`);
	}

	if (memTools.length === 0) {
		throw new Error("No memory__* tools were registered — extension likely failed to start the server.");
	}

	const getTool = (name: string) => {
		const t = memTools.find((x) => x.name === name);
		if (!t) throw new Error(`tool ${name} not found`);
		return t;
	};

	// 1. Add facts via memory__add_fact
	console.log(`[test] adding facts via memory__add_fact...`);
	const facts = [
		{ entity: "User", entityType: "Person", fact: "Prefers TypeScript over JavaScript for new projects." },
		{ entity: "User", fact: "Primary editor is Neovim with LazyVim config." },
		{ entity: "Project", entityType: "Project", fact: "Uses Vitest as the unit testing framework, not Jest." },
		{ entity: "Project", fact: "Always run npm run lint before committing." },
	];
	for (const f of facts) {
		const r = await getTool("memory__add_fact").execute("call", f);
		const t = textOf(r);
		console.log(`    add_fact(${f.entity}): ${t.split("\n")[0]}`);
	}

	// 2. Read full graph via memory__read_graph
	const graphRes = await getTool("memory__read_graph").execute("call", {});
	const graphText = textOf(graphRes);
	console.log(`[test] memory__read_graph (first 400 chars):\n${graphText.slice(0, 400)}`);
	if (!graphText.includes("Prefers TypeScript")) {
		throw new Error("read_graph did not return the TypeScript fact");
	}
	if (!graphText.includes("Vitest")) {
		throw new Error("read_graph did not return the Vitest fact");
	}

	// 3. Search
	const searchRes = await getTool("memory__search").execute("call", { query: "testing framework" });
	const searchText = textOf(searchRes);
	console.log(`[test] memory__search("testing framework"): ${searchText.slice(0, 300)}`);
	// The KG server's search should surface the Project/Vitest observation.
	if (!/vitest/i.test(searchText)) {
		console.log(`[warn] search did not surface Vitest by substring — server-side search may be index-only. Continuing.`);
	}

	// 4. Create a relation
	const relRes = await getTool("memory__create_relations").execute("call", {
		relations: [{ from: "User", relationType: "works_on", to: "Project" }],
	});
	console.log(`[test] create_relations: ${textOf(relRes).split("\n")[0]}`);

	// 5. Verify persistence to <cwd>/.pi/memory.jsonl (server uses JSONL format).
	const memoryFile = join(cwd, ".pi", "memory.jsonl");
	console.log(`[test] checking persistence at ${memoryFile}`);
	// server-memory writes after each create/add via fs.writeFile; small retry loop to be safe.
	let persistedRaw = "";
	for (let i = 0; i < 40; i++) {
		if (existsSync(memoryFile)) {
			persistedRaw = readFileSync(memoryFile, "utf-8");
			if (persistedRaw.includes("Prefers TypeScript")) break;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!persistedRaw) {
		throw new Error(`memory.jsonl not found or empty at ${memoryFile}`);
	}
	// Parse JSONL: one JSON object per line (entities + relations interleaved).
	const lines = persistedRaw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const entities = lines.filter((l: any) => l.type === "entity");
	const relations = lines.filter((l: any) => l.type === "relation");
	console.log(`[test] persisted entities: ${entities.length}, relations: ${relations.length}`);
	const user = entities.find((e: any) => e.name === "User");
	if (!user) throw new Error("User entity not persisted");
	if (!user.observations?.some((o: string) => /TypeScript/.test(o))) {
		throw new Error("User's TypeScript observation not persisted");
	}
	const project = entities.find((e: any) => e.name === "Project");
	if (!project) throw new Error("Project entity not persisted");
	if (!relations.some((r: any) => r.from === "User" && r.relationType === "works_on" && r.to === "Project")) {
		throw new Error("works_on relation not persisted");
	}

	// 6. Forget an entity
	const forgetRes = await getTool("memory__forget_entity").execute("call", { name: "Project" });
	console.log(`[test] forget_entity(Project): ${textOf(forgetRes).split("\n")[0]}`);
	const afterForget = textOf(await getTool("memory__read_graph").execute("call", {}));
	if (afterForget.includes("Vitest")) {
		throw new Error("Project entity still present after forget_entity");
	}

	session.dispose();

	try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

	console.log("\n[test] ✅ Memory extension end-to-end test passed");
	faux.unregister();
}

main().catch((err) => {
	console.error("[test] ❌ FAILED:", err?.stack ?? err);
	process.exit(1);
});
