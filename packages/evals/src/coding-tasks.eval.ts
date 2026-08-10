/**
 * Coding-task eval examples for @earendil-works/pi-evals.
 *
 * Demonstrates how to evaluate an agent's code-writing capability by:
 *  1. Giving the agent a small programming task in an isolated temp workspace
 *  2. After the agent finishes, running the produced code directly in Node.js
 *  3. Scoring with a judge function (not hard asserts) so the same task can
 *     be used for multi-model comparison via harness tables
 *
 * This is the eval-framework "hello world" described in PI-AGENT-ROADMAP:
 * write a `sum` function and verify it with real execution.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { createJudge, describeEval, type JsonValue } from "vitest-evals";
import { createPiCodingAgentHarness, type PiCodingAgentInput } from "./pi-harness.ts";

// ---------------------------------------------------------------------------
// Task 1: Write a `sum` function
// ---------------------------------------------------------------------------

type SumTestResult = { a: number; b: number; expected: number; actual: JsonValue; passed: boolean };

type SumTaskOutput = {
	response: string;
	fileExists: boolean;
	fileContent: string | null;
	testCases: SumTestResult[];
	allTestsPass: boolean;
};

const SUM_TASK_PROMPT = `Create a file called sum.js in the current directory that exports a function called sum.
The sum function takes two numbers and returns their sum.
Examples:
  sum(2, 3) should return 5
  sum(-1, 1) should return 0
  sum(0, 0) should return 0

Write the file using the write tool, then verify it works by running:
  node -e "const sum = require('./sum.js'); console.log(sum(2,3), sum(-1,1), sum(0,0));"

Do not create any other files. When you're done, respond with exactly "DONE".`;

function createSumTaskHarness(name: string) {
	return createPiCodingAgentHarness({
		name,
		output: ({ session }): SumTaskOutput => {
			const cwd = session.sessionManager.getCwd();
			const sumPath = join(cwd, "sum.js");
			let fileContent: string | null = null;
			let fileExists = false;
			try {
				fileContent = readFileSync(sumPath, "utf8");
				fileExists = true;
			} catch {
				fileExists = false;
			}

			// Run real Node.js test cases against the produced file
			const testCases: Array<{ a: number; b: number; expected: number }> = [
				{ a: 2, b: 3, expected: 5 },
				{ a: -1, b: 1, expected: 0 },
				{ a: 0, b: 0, expected: 0 },
				{ a: 100, b: 200, expected: 300 },
			];
			const results: SumTestResult[] = testCases.map((tc) => {
				try {
					const raw = execFileSync(
						process.execPath,
						[
							"-e",
							`const sum = require(${JSON.stringify(sumPath)}); console.log(JSON.stringify(sum(${tc.a},${tc.b})))`,
						],
						{ encoding: "utf8", timeout: 5000 },
					).trim();
					const actual = JSON.parse(raw) as JsonValue;
					return { ...tc, actual, passed: actual === tc.expected };
				} catch {
					return { ...tc, actual: "ERROR", passed: false };
				}
			});
			return {
				response: session.getLastAssistantText() ?? "",
				fileExists,
				fileContent,
				testCases: results,
				allTestsPass: results.every((r) => r.passed),
			};
		},
	});
}

// Judge: 1 point if file exists AND all test cases pass, 0 otherwise
const SumTaskJudge = createJudge<PiCodingAgentInput, SumTaskOutput>("SumTaskJudge", ({ output }) => {
	const failures: string[] = [];
	if (!output.fileExists) failures.push("sum.js does not exist");
	if (output.fileExists && !output.allTestsPass) {
		const failed = output.testCases.filter((t: SumTestResult) => !t.passed);
		failures.push(
			`${failed.length} test case(s) failed: ${failed
				.map((f: SumTestResult) => `${f.a}+${f.b}=${String(f.actual)} (expected ${f.expected})`)
				.join(", ")}`,
		);
	}
	return {
		score: failures.length === 0 ? 1 : 0,
		metadata: {
			passedTests: output.testCases.filter((t: SumTestResult) => t.passed).length,
			totalTests: output.testCases.length,
			rationale: failures.length === 0 ? "sum.js exists and all test cases pass" : failures.join("; "),
		},
	};
});

// Run the sum-task eval against one default harness (no comparison table)
describeEval(
	"Coding task: write sum() function",
	{
		harness: createSumTaskHarness("sum-function"),
		judges: [SumTaskJudge],
		judgeThreshold: null, // record score as observation, don't fail vitest on low score
	},
	(it) => {
		it("writes a correct sum.js file that passes all test cases", async ({ run }) => {
			const result = await run(SUM_TASK_PROMPT);
			// Hard invariants: harness should produce a result without errors
			expect(result.errors).toEqual([]);
			expect(result.usage.totalTokens).toBeGreaterThan(0);
			// Soft observation: file should exist (judge scores this)
			if (result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
				expect.soft((result.output as SumTaskOutput).fileExists).toBe(true);
			}
		});
	},
);
