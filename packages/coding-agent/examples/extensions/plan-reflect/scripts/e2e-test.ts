/**
 * e2e / unit tests for plan-reflect extension.
 *
 * Tests the pure helper functions (shouldPlanFor, isMeaningfulError, getToolTarget)
 * and verifies the extension can be loaded via tsx without errors.
 *
 * Run: npx tsx examples/extensions/plan-reflect/scripts/e2e-test.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Dynamically import the extension module and its exports
// ---------------------------------------------------------------------------

console.log("[0] Loading plan-reflect extension module...");
const mod = await import(resolve(EXT_DIR, "index.ts"));
const { shouldPlanFor, isMeaningfulError, getToolTarget, DEFAULT_CONFIG } = mod;
assert(shouldPlanFor, "exports shouldPlanFor");
assert(isMeaningfulError, "exports isMeaningfulError");
assert(getToolTarget, "exports getToolTarget");
assert(DEFAULT_CONFIG, "exports DEFAULT_CONFIG");
assert(DEFAULT_CONFIG.maxRetries === 2, "default maxRetries = 2");

// ---------------------------------------------------------------------------
// [1] shouldPlanFor — planning heuristics
// ---------------------------------------------------------------------------
section("[1] shouldPlanFor() — planning trigger heuristics");

// off mode = never plan
assert(shouldPlanFor("implement a full user auth system", "off") === false, "mode=off never plans (even for big tasks)");

// on mode = always plan for non-trivial prompts
assert(shouldPlanFor("hi", "on") === false, "mode=on: very short prompts don't trigger plan");
assert(shouldPlanFor("fix the login bug in auth.ts", "on") === true, "mode=on: substantive prompts trigger plan");

// auto mode = keyword-based triggers
assert(shouldPlanFor("ls", "auto") === false, "auto: trivial command 'ls' → no plan");
assert(shouldPlanFor("hello", "auto") === false, "auto: greeting → no plan");
assert(shouldPlanFor("implement the new feature X", "auto") === true, "auto: 'implement' → plan");
assert(shouldPlanFor("fix the null pointer bug", "auto") === true, "auto: 'fix' + 'bug' → plan");
assert(shouldPlanFor("add a new API endpoint", "auto") === true, "auto: 'add' → plan");
assert(shouldPlanFor("create a new component", "auto") === true, "auto: 'create' → plan");
assert(shouldPlanFor("refactor the auth module", "auto") === true, "auto: 'refactor' → plan");
assert(shouldPlanFor("write tests for utils", "auto") === true, "auto: 'write' → plan");
assert(shouldPlanFor("A".repeat(150), "auto") === true, "auto: very long prompt (>120 chars) → plan");
assert(
  shouldPlanFor("read the file config.ts and explain what it does", "auto") === false,
  "auto: read-only exploration → no plan",
);

// Chinese keywords
assert(shouldPlanFor("实现用户登录功能", "auto") === true, "auto: 中文 '实现' → plan");
assert(shouldPlanFor("修复这个 bug", "auto") === true, "auto: 中文 '修复' → plan");
assert(shouldPlanFor("添加新组件", "auto") === true, "auto: 中文 '添加' → plan");

// ---------------------------------------------------------------------------
// [2] getToolTarget — retry grouping key
// ---------------------------------------------------------------------------
section("[2] getToolTarget() — retry target extraction");

assert(
  getToolTarget("bash", { command: "npm install" }) === "npm install",
  "bash: extracts command snippet",
);
assert(
  getToolTarget("bash", { command: "rm -rf /some/very/long/path/that/should/be/truncated/xyz" }).length <= 80,
  "bash: long commands are truncated to 80 chars",
);
assert(
  getToolTarget("edit", { file_path: "/src/foo.ts" }) === "/src/foo.ts",
  "edit: extracts file_path",
);
assert(
  getToolTarget("write", { file_path: "/src/bar.ts" }) === "/src/bar.ts",
  "write: extracts file_path",
);
assert(
  getToolTarget("read", { file_path: "/src/baz.ts" }) === "/src/baz.ts",
  "read: extracts file_path",
);
assert(
  getToolTarget("grep", { pattern: "TODO" }) === "TODO",
  "grep: extracts pattern",
);
assert(
  getToolTarget("ls", { path: "/home/user" }) === "/home/user",
  "ls: extracts path",
);
assert(
  getToolTarget("find", { path: "src" }) === "src",
  "find: extracts path",
);
assert(
  getToolTarget("custom_tool", { action: "deploy", env: "prod" }).length <= 80,
  "custom tools: JSON-stringified, truncated",
);

// ---------------------------------------------------------------------------
// [3] isMeaningfulError — error detection
// ---------------------------------------------------------------------------
section("[3] isMeaningfulError() — meaningful error detection");

function makeBashError(output: string) {
  return {
    type: "tool_result" as const,
    toolCallId: "1",
    toolName: "bash" as const,
    input: { command: "test" },
    content: [{ type: "text" as const, text: output }],
    isError: true,
    details: undefined,
  };
}

function makeBashSuccess(output: string) {
  return { ...makeBashError(output), isError: false };
}

assert(isMeaningfulError(makeBashSuccess("hello world")) === false, "success result → not an error");
assert(
  isMeaningfulError({ ...makeBashError(""), content: [] }) === false,
  "error with empty content → ignored",
);
assert(isMeaningfulError(makeBashError("command not found: fooo")) === true, "'command not found' → error");
assert(isMeaningfulError(makeBashError("npm ERR! code ENOENT")) === true, "'ENOENT' → error");
assert(isMeaningfulError(makeBashError("EACCES: permission denied")) === true, "'permission denied' → error");
assert(isMeaningfulError(makeBashError("bash: cd: no such file or directory")) === true, "'no such file' → error");
assert(isMeaningfulError(makeBashError("TypeError: cannot read property of undefined")) === true, "'TypeError' → error");
assert(isMeaningfulError(makeBashError("ReferenceError: x is not defined")) === true, "'ReferenceError' → error");
assert(isMeaningfulError(makeBashError("syntax error near unexpected token")) === true, "'syntax error' → error");
assert(isMeaningfulError(makeBashError("exited with code 1")) === true, "'exited with code' → error");
assert(isMeaningfulError(makeBashError("timed out after 30s")) === true, "'timed out' → error");
assert(isMeaningfulError(makeBashError("connection refused")) === true, "'connection refused' → error");
assert(
  isMeaningfulError(makeBashError("build completed successfully\nfound 0 errors")) === false,
  "output containing 'error' in non-failure context (counts = 0 errors) → not reflected on",
);

// Edit tool errors
assert(
  isMeaningfulError({
    type: "tool_result",
    toolCallId: "2",
    toolName: "edit" as const,
    input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
    content: [{ type: "text" as const, text: "Error: old_string not found in file" }],
    isError: true,
    details: undefined,
  }) === true,
  "edit tool: 'old_string not found' → error",
);

// ---------------------------------------------------------------------------
// [4] TypeScript compile check via tsx (no tsc needed)
// ---------------------------------------------------------------------------
section("[4] TypeScript dynamic loading check");

const result = spawnSync(
  "npx",
  ["tsx", "-e", `import("${EXT_DIR}/index.ts").then(m => console.log("OK:", Object.keys(m).length, "exports"))`],
  { cwd: resolve(__dirname, "../../../../.."), encoding: "utf8" },
);
assert(result.status === 0, `tsx loads extension without errors (exit ${result.status})`);
if (result.stdout) assert(result.stdout.includes("OK:"), `loaded module reports exports: ${result.stdout.trim()}`);
if (result.stderr && !result.stderr.includes("ExperimentalWarning")) {
  console.log(`  stderr: ${result.stderr.trim().slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
console.log("All plan-reflect tests passed ✅");
