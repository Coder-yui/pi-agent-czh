/**
 * Sandbox Extension — OS-level sandboxing + command safety layer for pi.
 *
 * Two layers of defense:
 *   1. **Lethal command filter**: blocks obviously destructive commands (rm -rf /,
 *      mkfs, fork bombs, dd to block devices, etc.) before they even hit the OS
 *      sandbox. This is defense-in-depth — the OS sandbox would catch most of
 *      these too, but an explicit deny gives the agent a clearer error.
 *   2. **OS sandbox**: uses @anthropic-ai/sandbox-runtime (sandbox-exec on macOS,
 *      bubblewrap on Linux) to enforce filesystem read/write restrictions and
 *      network egress filtering per process.
 *
 * All commands are logged to `<agentDir>/sandbox-audit.jsonl` for later inspection.
 *
 * Config files (merged; project takes precedence over global):
 *   - ~/.pi/agent/extensions/sandbox.json   (global)
 *   - <cwd>/.pi/sandbox.json                (project-local)
 *
 * Usage:
 *   pi -e ./sandbox                   # enable sandbox with default/config settings
 *   pi -e ./sandbox --no-sandbox      # disable OS-level sandbox (lethal filter + audit still active)
 *   /sandbox                          # show current sandbox status
 *   /sandbox log [N]                  # show last N audit entries (default 10)
 *   /sandbox test                     # run a self-test (try to read ~/.ssh, expect deny)
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	CONFIG_DIR_NAME,
	createBashTool,
	createLocalBashOperations,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
	/** Lethal command patterns — blocked even before OS sandbox. */
	blockLethal?: boolean;
}

interface AuditEntry {
	ts: string;
	command: string;
	cwd: string;
	mode: "blocked-lethal" | "sandboxed" | "audit-only" | "local" | "error";
	reason?: string;
	exitCode?: number | null;
	durationMs?: number;
	violations?: string[];
}

type SandboxMode = "off" | "audit-only" | "on" | "unavailable";

// ---------------------------------------------------------------------------
// Lethal command patterns (blocked BEFORE entering the sandbox)
// ---------------------------------------------------------------------------
// These are patterns that no coding agent should ever execute. The OS sandbox
// would catch many of them, but explicit rejection gives a clearer error and
// protects against sandbox misconfiguration.

interface LethalPattern {
	re: RegExp;
	reason: string;
	/** If true, match against the full raw command (not split by ;/&&/||). */
	matchFull?: boolean;
}

const LETHAL_PATTERNS: LethalPattern[] = [
	// Recursive removal of root or home (supports -rf, -r -f, --recursive --force etc.)
	{
		re: /(?:^|[\s;|&])(?:sudo\s+)?rm\s+(?:(?:--recursive|--force|-[a-zA-Z]*[rRf][a-zA-Z]*)\s+)*(?:--no-preserve-root\s+)?\/\s*(?:$|;|&|\||#)/,
		reason: "refusing to 'rm -rf /' (would destroy the system)",
	},
	{
		re: /(?:^|[\s;|&])(?:sudo\s+)?rm\s+(?:(?:--recursive|--force|-[a-zA-Z]*[rRf][a-zA-Z]*)\s+)+~\/?\s*(?:$|;|&|\||#)/,
		reason: "refusing to recursively delete home directory",
	},
	// Format disks / write to block devices
	{
		re: /(?:^|[\s;|&])(?:sudo\s+)?(?:mkfs|fdisk|parted)\b/,
		reason: "refusing to run disk-formatting/partitioning tools",
	},
	{
		re: /(?:^|[\s;|&])(?:sudo\s+)?dd\b[^&|;]*\bof=\/dev\/(?:sd|hd|nvme|disk|mem|kmem)\w+/,
		reason: "refusing 'dd' to a block/kmem device (would overwrite disk/memory)",
	},
	// Fork bomb — classic bash fork bomb (must match against full command, not segments).
	{ re: /:\s*\(\s*\)\s*\{[^}]*:\|:\s*&[^}]*\}\s*;/, reason: "refusing to execute a fork bomb", matchFull: true },
	{ re: /\bfork\s*bomb\b/i, reason: "refusing fork bomb invocation", matchFull: true },
	// Shutdown / reboot / init 0/6 (must be the command, not an argument to grep/echo/etc.)
	{
		re: /(?:^|[\s;|&])(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff|init\s+[06]|telinit\s+[06])\b/,
		reason: "refusing system shutdown/reboot commands",
	},
	// chmod 777 on system dirs
	{
		re: /(?:^|[\s;|&])(?:sudo\s+)?chmod\s+(?:-R\s+)?777\s+(?:\/(?:etc|usr|bin|sbin|var|root|System|opt|boot)|~)/,
		reason: "refusing chmod 777 on system directories",
	},
	// Write directly to disk devices via redirect
	{ re: />\s*\/dev\/(?:sd|hd|nvme|disk|mem|kmem)\w+/, reason: "refusing redirect to a block/kmem device" },
	// curl | sh / wget | sh style remote code execution
	{
		re: /\|\s*(?:sudo\s+)?(?:ba)?sh\b/,
		reason: "refusing pipe-to-shell remote code execution (download the script first and inspect it)",
	},
	// Cryptomining / known malware-ish commands
	{ re: /(?:^|[\s;|&])(?:xmrig|minerd|cpuminer|ccminer|ethminer)\b/, reason: "refusing known cryptominer binaries" },
];

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	blockLethal: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"files.pythonhosted.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"objects.githubusercontent.com",
			"*.googleapis.com",
			"*.docker.com",
			"*.docker.io",
			"*.microsoft.com",
		],
		deniedDomains: ["169.254.169.254"], // block cloud metadata by default
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.kube", "~/.azure", "~/.config/gcloud"],
		allowWrite: [".", "/tmp", "~/Library/Caches/pi-agent-czh"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*"],
	},
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };
	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.blockLethal !== undefined) result.blockLethal = overrides.blockLethal;
	if (overrides.network) result.network = { ...base.network, ...overrides.network };
	if (overrides.filesystem) result.filesystem = { ...base.filesystem, ...overrides.filesystem };

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };
	if (extOverrides.ignoreViolations) extResult.ignoreViolations = extOverrides.ignoreViolations;
	if (extOverrides.enableWeakerNestedSandbox !== undefined)
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	return result;
}

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "sandbox.json");
	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};
	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`[sandbox] bad global config: ${e}`);
		}
	}
	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`[sandbox] bad project config: ${e}`);
		}
	}
	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function getAuditPath(): string {
	const dir = getAgentDir();
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
	return join(dir, "sandbox-audit.jsonl");
}

function appendAudit(entry: AuditEntry) {
	try {
		const line = `${JSON.stringify(entry)}\n`;
		appendFileSync(getAuditPath(), line);
	} catch {
		// Audit failures must not break execution.
	}
}

function readAuditTail(n: number): AuditEntry[] {
	try {
		const raw = readFileSync(getAuditPath(), "utf-8");
		const lines = raw.trim().split("\n").filter(Boolean);
		return lines.slice(-n).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Lethal command check
// ---------------------------------------------------------------------------

/** @internal Exported for tests */
export function checkLethal(command: string): { blocked: boolean; reason?: string } {
	const trimmed = command.trim();

	// Pass 1: patterns that need the full raw command (e.g. fork bombs that
	// contain ';' which would be cut by segment splitting).
	for (const { re, reason, matchFull } of LETHAL_PATTERNS) {
		if (matchFull && re.test(trimmed)) return { blocked: true, reason };
	}

	// Pass 2: segment-by-segment — split on ;, &&, || so that patterns anchored
	// to command-start (e.g. `\bsudo shutdown\b`) don't flag 'grep shutdown'.
	const segments = trimmed.split(/\s*(?:;|&&|\|\|)\s*/);
	for (const seg of segments) {
		const s = seg.trim();
		if (!s) continue;
		for (const { re, reason, matchFull } of LETHAL_PATTERNS) {
			if (matchFull) continue;
			if (re.test(s)) return { blocked: true, reason };
		}
	}
	return { blocked: false };
}

// ---------------------------------------------------------------------------
// Sandboxed BashOperations
// ---------------------------------------------------------------------------

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}
			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);
			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});
				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands (lethal filter + audit remain active)",
		type: "boolean",
		default: false,
	});

	let sandboxMode: SandboxMode = "on";
	let sandboxInitialized = false;
	let currentConfig: SandboxConfig = DEFAULT_CONFIG;
	const localOps = createLocalBashOperations();
	const localBash = createBashTool(process.cwd(), { operations: localOps });

	// Register the bash tool override.
	pi.registerTool({
		...localBash,
		name: "bash",
		label: "bash (sandboxed)",
		description:
			localBash.description +
			" Commands are filtered for obviously dangerous patterns and executed inside an OS-level sandbox (filesystem + network restrictions) when enabled.",
		async execute(id, params, signal, onUpdate, ctx) {
			const { command } = params as { command: string; timeout?: number };
			const startedAt = Date.now();

			// Always-on: lethal command filter.
			if (currentConfig.blockLethal !== false) {
				const lethal = checkLethal(command);
				if (lethal.blocked) {
					const msg = `[SANDBOX BLOCKED] ${lethal.reason}\n\nCommand rejected: ${command}\n\nThis command is blocked by the always-on lethal filter. To allow it, explicitly set blockLethal=false in the sandbox configuration.`;
					appendAudit({
						ts: new Date().toISOString(),
						command,
						cwd: ctx.cwd,
						mode: "blocked-lethal",
						reason: lethal.reason,
					});
					if (onUpdate) onUpdate({ content: [{ type: "text", text: msg }], details: undefined });
					throw new Error(msg);
				}
			}
			if (sandboxMode === "unavailable") {
				const message =
					"[SANDBOX UNAVAILABLE] Isolation was explicitly required, but the OS sandbox failed to initialize.";
				appendAudit({
					ts: new Date().toISOString(),
					command,
					cwd: ctx.cwd,
					mode: "error",
					reason: message,
				});
				throw new Error(message);
			}

			// Pick the execution backend.
			let ops: BashOperations;
			let mode: AuditEntry["mode"];
			if (sandboxMode === "on" && sandboxInitialized) {
				ops = createSandboxedBashOps();
				mode = "sandboxed";
			} else {
				ops = localOps;
				mode = sandboxMode === "off" ? "local" : "audit-only";
			}

			const sandboxedBash = createBashTool(ctx.cwd, { operations: ops });
			try {
				const result = await sandboxedBash.execute(id, params, signal, onUpdate);
				appendAudit({
					ts: new Date().toISOString(),
					command,
					cwd: ctx.cwd,
					mode,
					exitCode: 0,
					durationMs: Date.now() - startedAt,
				});
				return result;
			} catch (error: unknown) {
				// Non-zero exit codes come through as thrown errors from createBashTool.
				const message = error instanceof Error ? error.message : String(error);
				const exitMatch = /exited with code (\d+)/.exec(message);
				appendAudit({
					ts: new Date().toISOString(),
					command,
					cwd: ctx.cwd,
					mode: message.includes("[SANDBOX BLOCKED]") ? "blocked-lethal" : "error",
					exitCode: exitMatch ? Number(exitMatch[1]) : null,
					durationMs: Date.now() - startedAt,
					reason: message.slice(0, 200),
				});
				throw error;
			}
		},
	});

	// Also intercept direct !/!! commands. This path needs its own lethal check
	// and audit wrapper because it does not execute through the overridden tool.
	pi.on("user_bash", (event) => {
		if (currentConfig.blockLethal !== false) {
			const lethal = checkLethal(event.command);
			if (lethal.blocked) {
				const output = `[SANDBOX BLOCKED] ${lethal.reason}\nCommand rejected: ${event.command}\n`;
				appendAudit({
					ts: new Date().toISOString(),
					command: event.command,
					cwd: event.cwd,
					mode: "blocked-lethal",
					reason: lethal.reason,
					exitCode: 126,
				});
				return { result: { output, exitCode: 126, cancelled: false, truncated: false } };
			}
		}
		if (sandboxMode === "unavailable") {
			const output = "[SANDBOX UNAVAILABLE] Isolation is required but unavailable; command refused.\n";
			appendAudit({
				ts: new Date().toISOString(),
				command: event.command,
				cwd: event.cwd,
				mode: "error",
				reason: output.trim(),
				exitCode: 125,
			});
			return { result: { output, exitCode: 125, cancelled: false, truncated: false } };
		}

		const mode: AuditEntry["mode"] =
			sandboxMode === "on" && sandboxInitialized ? "sandboxed" : sandboxMode === "off" ? "local" : "audit-only";
		const base = mode === "sandboxed" ? createSandboxedBashOps() : localOps;
		const operations: BashOperations = {
			async exec(command, cwd, options) {
				const startedAt = Date.now();
				try {
					const result = await base.exec(command, cwd, options);
					appendAudit({
						ts: new Date().toISOString(),
						command,
						cwd,
						mode,
						exitCode: result.exitCode,
						durationMs: Date.now() - startedAt,
					});
					return result;
				} catch (error) {
					appendAudit({
						ts: new Date().toISOString(),
						command,
						cwd,
						mode: "error",
						exitCode: null,
						durationMs: Date.now() - startedAt,
						reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
					});
					throw error;
				}
			},
		};
		return { operations };
	});

	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;
		currentConfig = loadConfig(ctx.cwd);
		const requestedMode = process.env.PI_SANDBOX_MODE;
		if (requestedMode && !["on", "audit-only", "off"].includes(requestedMode)) {
			ctx.ui.notify(`Ignoring invalid PI_SANDBOX_MODE=${requestedMode}; expected on, audit-only, or off`, "warning");
		}
		const configuredMode =
			requestedMode === "on" || requestedMode === "audit-only" || requestedMode === "off"
				? requestedMode
				: undefined;

		if (noSandbox || configuredMode === "off" || configuredMode === "audit-only" || !currentConfig.enabled) {
			sandboxMode = noSandbox || configuredMode === "off" ? "off" : "audit-only";
			sandboxInitialized = false;
			ctx.ui.notify(
				sandboxMode === "off"
					? "Sandbox: disabled (--no-sandbox); lethal filter + audit still active"
					: "Sandbox: audit-only mode (explicit mode or config.enabled=false)",
				"warning",
			);
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("warning", noSandbox ? "🔓 Sandbox: OFF" : "📝 Sandbox: audit-only"),
			);
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxMode = configuredMode === "on" ? "unavailable" : "audit-only";
			sandboxInitialized = false;
			ctx.ui.notify(
				configuredMode === "on"
					? `Sandbox: OS-level sandbox not supported on ${platform}; commands will be refused`
					: `Sandbox: OS-level sandbox not supported on ${platform}; audit-only mode`,
				"warning",
			);
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg(
					"warning",
					sandboxMode === "unavailable" ? "Sandbox: unavailable (fail-closed)" : "Sandbox: audit-only",
				),
			);
			return;
		}

		try {
			const configExt = currentConfig as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};
			await SandboxManager.initialize({
				network: currentConfig.network,
				filesystem: currentConfig.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});
			sandboxMode = "on";
			sandboxInitialized = true;

			const netCount = currentConfig.network?.allowedDomains?.length ?? 0;
			const writeCount = currentConfig.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${netCount} domains, ${writeCount} write paths`),
			);
			ctx.ui.notify(
				`Sandbox: active (${netCount} allowed domains, ${writeCount} write paths, lethal filter on)`,
				"info",
			);
		} catch (error: unknown) {
			sandboxMode = configuredMode === "on" ? "unavailable" : "audit-only";
			sandboxInitialized = false;
			ctx.ui.notify(
				configuredMode === "on"
					? `Sandbox initialization failed: ${error instanceof Error ? error.message : error}; commands will be refused because PI_SANDBOX_MODE=on`
					: `Sandbox initialization failed: ${error instanceof Error ? error.message : error}; falling back to audit-only mode`,
				"error",
			);
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg(
					"warning",
					sandboxMode === "unavailable" ? "Sandbox: unavailable (fail-closed)" : "Sandbox: audit-only",
				),
			);
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				/* ignore cleanup errors */
			}
			sandboxInitialized = false;
		}
	});

	// ---------------------------------------------------------------------------
	// /sandbox command
	// ---------------------------------------------------------------------------

	pi.registerCommand("sandbox", {
		description: "Sandbox control: /sandbox [status|log <N>|test]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "status";

			if (sub === "log") {
				const n = Math.max(1, Math.min(100, parseInt(parts[1] ?? "10", 10) || 10));
				const entries = readAuditTail(n);
				if (entries.length === 0) {
					ctx.ui.notify("No audit entries yet.", "info");
					return;
				}
				const lines = entries.map((e) => {
					const icon =
						e.mode === "blocked-lethal"
							? "🚫"
							: e.mode === "sandboxed"
								? "🔒"
								: e.mode === "audit-only"
									? "📝"
									: "⚪";
					const dur = e.durationMs != null ? ` (${e.durationMs}ms)` : "";
					const ec = e.exitCode != null ? ` exit=${e.exitCode}` : "";
					return `${icon} [${e.ts.slice(11, 19)}] ${e.mode}${dur}${ec}  ${e.command.length > 80 ? `${e.command.slice(0, 80)}…` : e.command}`;
				});
				ctx.ui.notify(`Last ${entries.length} sandbox audit entries:\n\n${lines.join("\n")}`, "info");
				return;
			}

			if (sub === "test") {
				ctx.ui.notify("Running sandbox self-test…", "info");
				// We can't easily run a test command that shows sandbox violation inline,
				// but we can check the lethal filter by using read directly.
				const lethal = checkLethal("rm -rf /");
				const auditOk = existsSync(getAuditPath());
				const lines = [
					`Lethal filter: ${lethal.blocked ? "✅ working" : "❌ NOT working"} (rm -rf / → ${lethal.reason ?? "not blocked"})`,
					`OS sandbox:    ${sandboxMode === "on" ? "✅ active" : sandboxMode === "audit-only" ? "⚠️ audit-only (no OS enforcement)" : sandboxMode === "unavailable" ? "❌ unavailable (fail-closed)" : "❌ off"}`,
					`Audit log:     ${auditOk ? "✅" : "⚠️ (no entries yet)"} ${getAuditPath()}`,
					`Platform:      ${process.platform}`,
					"",
					"To test filesystem enforcement, ask the agent to 'cat ~/.ssh/id_rsa' — sandbox should deny it and return a permission error.",
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// status (default)
			const netAllow = currentConfig.network?.allowedDomains?.length ?? 0;
			const netDeny = currentConfig.network?.deniedDomains?.length ?? 0;
			const fsDenyRead = currentConfig.filesystem?.denyRead?.length ?? 0;
			const fsAllowWrite = currentConfig.filesystem?.allowWrite?.length ?? 0;
			const fsDenyWrite = currentConfig.filesystem?.denyWrite?.length ?? 0;
			const modeLabel =
				sandboxMode === "on"
					? "🔒 OS sandbox active"
					: sandboxMode === "audit-only"
						? "📝 audit-only (commands logged, not sandboxed)"
						: sandboxMode === "unavailable"
							? "❌ unavailable (commands refused)"
							: "🔓 off (no OS sandbox)";
			const recent = readAuditTail(3);
			const recentStr =
				recent.length === 0
					? "(none yet)"
					: recent.map((e) => `  - ${e.mode}: ${e.command.slice(0, 70)}`).join("\n");
			const lines = [
				`Sandbox status: ${modeLabel}`,
				`Lethal filter: ${currentConfig.blockLethal !== false ? "✅ on" : "❌ off"}`,
				"",
				`Network: ${netAllow} allowed domains, ${netDeny} denied`,
				`Filesystem: denyRead=${fsDenyRead}, allowWrite=${fsAllowWrite}, denyWrite=${fsDenyWrite}`,
				"",
				`Recent commands:\n${recentStr}`,
				"",
				"Subcommands: /sandbox log [N] — view audit log; /sandbox test — run self-test",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
