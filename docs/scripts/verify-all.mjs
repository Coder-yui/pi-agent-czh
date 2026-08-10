#!/usr/bin/env node
/**
 * 对 pi-agent-czh 的现代 Agent 扩展运行真实验证。
 *
 * 用法：
 *   node docs/scripts/verify-all.mjs           # 全部 Phase
 *   node docs/scripts/verify-all.mjs 1 2 4     # 指定 Phase
 *
 * 脚本可以从仓库根目录或 pi-main/ 运行。依赖缺失会失败，不会跳过。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const currentDirectory = process.cwd();
const repositoryRoot = currentDirectory.endsWith("pi-main")
	? currentDirectory
	: resolve(currentDirectory, "pi-main");

if (!existsSync(resolve(repositoryRoot, "PI-AGENT-ROADMAP.md"))) {
	console.error(`请在 pi-agent-czh 仓库根目录或 pi-main/ 运行此脚本。当前位置：${currentDirectory}`);
	process.exit(2);
}

const tsx = resolve(repositoryRoot, "node_modules/.bin/tsx");
const vitest = resolve(repositoryRoot, "node_modules/.bin/vitest");
const tsgo = resolve(repositoryRoot, "node_modules/.bin/tsgo");
const modelEvaluationConfigured = Boolean(process.env.PI_PROVIDER?.trim() && process.env.PI_MODEL?.trim());

const checks = [
	{
		phase: 0,
		label: "全项目 TypeScript 类型检查",
		command: tsgo,
		args: ["--noEmit", "--pretty", "false"],
	},
	{
		phase: 1,
		label: "MCP：真实 stdio server、分页发现、模板与工具调用",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/mcp/scripts/e2e-test.ts"],
	},
	{
		phase: 1,
		label: "Memory：真实 MCP memory server、相关检索与跨进程持久化",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/memory/scripts/e2e-test.ts"],
	},
	{
		phase: 2,
		label: "ACP：真实协议连接、权限桥接、流式回复与会话关闭",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/acp/scripts/e2e-test.ts"],
	},
	{
		phase: 2,
		label: "Sandbox：真实 OS 隔离、致命命令拦截与审计",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/sandbox/scripts/e2e-test.ts"],
	},
	{
		phase: 3,
		label: "Plan/Reflect：模式切换、重试阻断与状态持久化",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/plan-reflect/scripts/e2e-test.ts"],
	},
	{
		phase: 3,
		label: "Evals：评测框架单元测试",
		command: vitest,
		args: ["run", "--config", "vitest.test.config.ts"],
		cwd: resolve(repositoryRoot, "packages/evals"),
	},
	{
		phase: 3,
		label: "Evals：真实模型编写并执行 sum.js",
		command: process.execPath,
		args: ["scripts/run-evals.mjs", "src/coding-tasks.eval.ts"],
		cwd: resolve(repositoryRoot, "packages/evals"),
		requiresModel: true,
	},
	{
		phase: 4,
		label: "A2A：Agent Card、增量流、失败/取消与委派往返",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/a2a/scripts/test-a2a.mjs"],
	},
	{
		phase: 5,
		label: "Economy：标准 JWS、并发幂等支付、报价与发现",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/economy/scripts/test-economy.mjs"],
	},
	{
		phase: 6,
		label: "Agent Loop：真实会话续跑、checkpoint 与硬预算",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/agent-loop/scripts/e2e-test.ts"],
	},
	{
		phase: 6,
		label: "Agent Graph：LangGraph 条件路由、循环、取消与工具适配",
		command: tsx,
		args: ["packages/coding-agent/examples/extensions/agent-graph/scripts/e2e-test.ts"],
	},
];

const requestedPhases = new Set(
	process.argv
		.slice(2)
		.map(Number)
		.filter((phase) => Number.isInteger(phase) && phase >= 1 && phase <= 6),
);
const requestedChecks = checks.filter(
	(check) => requestedPhases.size === 0 || (check.phase !== 0 && requestedPhases.has(check.phase)),
);
const selectedChecks = requestedChecks.filter((check) => !check.requiresModel || modelEvaluationConfigured);
const skippedModelEvaluation = requestedChecks.some((check) => check.requiresModel) && !modelEvaluationConfigured;

console.log(`pi-agent-czh 真实能力验证（${selectedChecks.length} 项）`);
console.log(`仓库：${repositoryRoot}\n`);
if (skippedModelEvaluation) {
	console.log("[Phase 3] 未设置 PI_PROVIDER + PI_MODEL：只验证 eval 框架，不把模型编程评测计为已运行。\n");
}

let passed = 0;
for (const check of selectedChecks) {
	console.log(`[${check.phase === 0 ? "基础" : `Phase ${check.phase}`}] ${check.label}`);
	if (!existsSync(check.command)) {
		console.error(`  失败：缺少 ${check.command}，请先在 pi-main 执行 npm install。\n`);
		continue;
	}

	const result = spawnSync(check.command, check.args, {
		cwd: check.cwd ?? repositoryRoot,
		encoding: "utf8",
		stdio: "inherit",
		env: process.env,
	});
	if (result.status === 0) {
		passed += 1;
		console.log("  通过\n");
	} else {
		console.error(`  失败（退出码 ${result.status ?? "未知"}）\n`);
	}
}

const failed = selectedChecks.length - passed;
console.log(`结果：${passed}/${selectedChecks.length} 通过，${failed} 失败。`);
process.exit(failed === 0 ? 0 : 1);
