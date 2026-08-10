# Agent Loop extension

This extension adds a bounded harness-level loop to pi. It follows Google ADK `LoopAgent`'s control pattern: run the normal agent, require an explicit termination signal, and retain a deterministic maximum-iteration fallback.

## Implemented capabilities

- Runs each iteration as a complete pi `AgentSession` run, so the selected model, built-in tools, MCP tools, memory, sandbox, planning, and other loaded extensions remain available.
- Starts only through an explicit user command; the model cannot silently create an autonomous loop.
- Injects the unchanged goal, current iteration, remaining tool budget, and deadline into each iteration's system prompt.
- Registers `agent_loop_checkpoint`, which requires one `continue`, `complete`, or `blocked` decision with progress and evidence per iteration.
- Automatically queues the next full agent run only after a valid `continue` checkpoint.
- Enforces independent maximum iteration, tool-call, and wall-clock budgets.
- Pauses fail-closed if an iteration ends without a checkpoint.
- Persists loop state and checkpoints as pi session entries. Reloaded running loops become paused and require explicit resume, preventing unattended restart.
- Supports status, pause, resume with optional increased iteration limit, and stop commands.

## Commands

```text
/agent-loop start <goal> [--max-iterations=N] [--max-tools=N] [--timeout-minutes=N]
/agent-loop status
/agent-loop pause
/agent-loop resume [--max-iterations=N] [user guidance]
/agent-loop stop
```

Load it with:

```bash
./pi-test.sh -e packages/coding-agent/examples/extensions/agent-loop/index.ts
```

Run the deterministic real-session regression:

```bash
./node_modules/.bin/tsx packages/coding-agent/examples/extensions/agent-loop/scripts/e2e-test.ts
```

## Boundaries

- A `complete` checkpoint is still an agent judgment. The extension requires evidence and applies hard budgets, but it is not a formal verifier.
- The loop is sequential. Parallel fan-out belongs to Agent Graph or the subagent extension.
- A process/session restart never resumes autonomous execution automatically.

Reference: [Google ADK Loop agents](https://google.github.io/adk-docs/agents/workflow-agents/loop-agents/).
