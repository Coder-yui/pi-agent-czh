import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GraphNodeExecutor, GraphNodeResult } from "./engine.ts";
import type { AgentGraphAgentNode } from "./schema.ts";

const DEFAULT_NODE_TIMEOUT_MS = 10 * 60_000;
const PROCESS_OUTPUT_LIMIT = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript) {
		const executableName = basename(process.execPath).toLowerCase();
		if (!/^(node|bun)(\.exe)?$/.test(executableName)) return { command: process.execPath, args };
		if (!currentScript.includes("tsx") && !currentScript.includes("vitest")) {
			return { command: process.execPath, args: [currentScript, ...args] };
		}
	}
	return { command: "pi", args };
}

function resolveNodeCwd(root: string, requested: string | undefined): string {
	if (!requested) return root;
	if (isAbsolute(requested)) throw new Error("Agent Graph node cwd must be project-relative");
	const resolved = resolve(root, requested);
	const relation = relative(root, resolved);
	if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
		throw new Error("Agent Graph node cwd cannot escape the project root");
	}
	return resolved;
}

function appendBounded(current: string, chunk: string): string {
	if (current.length >= PROCESS_OUTPUT_LIMIT) return current;
	return (current + chunk).slice(0, PROCESS_OUTPUT_LIMIT);
}

function extractAssistantText(event: unknown): { text?: string; stopReason?: string; errorMessage?: string } {
	if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return {};
	const message = event.message;
	if (message.role !== "assistant" || !Array.isArray(message.content)) return {};
	const text = message.content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("\n");
	return {
		text,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
	};
}

async function runPiAgentNode(
	node: AgentGraphAgentNode,
	task: string,
	projectRoot: string,
	signal?: AbortSignal,
): Promise<GraphNodeResult> {
	const nodeCwd = resolveNodeCwd(projectRoot, node.cwd);
	const args = ["--mode", "json", "-p", "--no-session"];
	if (node.model) args.push("--model", node.model);
	if (node.tools && node.tools.length > 0) args.push("--tools", node.tools.join(","));

	let temporaryDirectory: string | undefined;
	if (node.systemPrompt) {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-agent-graph-"));
		const promptPath = join(temporaryDirectory, "system-prompt.md");
		await writeFile(promptPath, node.systemPrompt, { encoding: "utf8", mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}
	args.push(`Task: ${task}`);

	const startedAt = Date.now();
	let stdoutBuffer = "";
	let stderr = "";
	let assistantOutput = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let spawnError: Error | undefined;
	let timedOut = false;
	const invocation = getPiInvocation(args);
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(invocation.command, invocation.args, {
			cwd: nodeCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
		throw error;
	}
	if (!child.stdout || !child.stderr) {
		child.kill();
		if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
		throw new Error("Agent Graph pi process did not expose piped stdout/stderr");
	}

	const processLine = (line: string): void => {
		if (!line.trim()) return;
		try {
			const extracted = extractAssistantText(JSON.parse(line) as unknown);
			if (extracted.text !== undefined) assistantOutput = extracted.text;
			if (extracted.stopReason !== undefined) stopReason = extracted.stopReason;
			if (extracted.errorMessage !== undefined) errorMessage = extracted.errorMessage;
		} catch {
			// JSON mode may still emit non-protocol diagnostics; stderr captures actionable failures.
		}
	};

	child.stdout.on("data", (chunk: Buffer) => {
		stdoutBuffer = appendBounded(stdoutBuffer, chunk.toString());
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = appendBounded(stderr, chunk.toString());
	});
	child.on("error", (error) => {
		spawnError = error;
	});

	const terminate = (): void => {
		if (child.exitCode !== null) return;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 5000).unref();
	};
	const abortListener = (): void => terminate();
	if (signal?.aborted) terminate();
	else signal?.addEventListener("abort", abortListener, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		terminate();
	}, node.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS);
	timeout.unref();

	const exitCode = await new Promise<number>((complete) => {
		child.on("close", (code) => complete(code ?? 1));
	});
	clearTimeout(timeout);
	signal?.removeEventListener("abort", abortListener);
	if (stdoutBuffer.trim()) processLine(stdoutBuffer);
	if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });

	const failure = signal?.aborted
		? "Agent Graph node canceled"
		: timedOut
			? `Agent Graph node timed out after ${node.timeoutMs ?? DEFAULT_NODE_TIMEOUT_MS}ms`
			: spawnError?.message || errorMessage || stderr.trim() || `pi exited with code ${exitCode}`;
	const isFailure =
		signal?.aborted || timedOut || spawnError !== undefined || exitCode !== 0 || stopReason === "error";
	return {
		nodeId: node.id,
		nodeType: node.type,
		status: isFailure ? "failure" : "success",
		output: isFailure ? failure : assistantOutput || "(agent produced no text output)",
		exitCode,
		startedAt,
		completedAt: Date.now(),
	};
}

function createPiProcessNodeExecutor(projectRoot: string): GraphNodeExecutor {
	return async (node, context) => {
		if (node.type !== "agent") throw new Error(`Process executor cannot run ${node.type} nodes`);
		return runPiAgentNode(node, context.task, projectRoot, context.signal);
	};
}

export { createPiProcessNodeExecutor, extractAssistantText, getPiInvocation, resolveNodeCwd, runPiAgentNode };
