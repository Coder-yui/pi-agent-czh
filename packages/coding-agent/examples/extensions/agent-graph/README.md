# Agent Graph extension

This extension adds validated, stateful Agent Graph execution to pi using the official `@langchain/langgraph` `StateGraph` runtime. LangGraph owns graph compilation, state channels, conditional edges, cycles, and recursion limits; the adapter maps graph nodes to isolated pi agents and human approvals.

## Implemented capabilities

- Loads versioned JSON graph definitions from user and project scopes:
  - `~/.pi/agent/agent-graphs/<name>.json`
  - `<cwd>/.pi/agent-graphs/<name>.json` (overrides user scope)
- Validates definitions with Zod before execution: unique/reachable nodes, valid entrypoint and edge targets, one final fallback edge, safe identifiers, and size/count limits.
- Compiles every definition into a real LangGraph.js `StateGraph`.
- Supports two node types:
  - `agent`: launches an isolated full pi process with optional model, tool allowlist, system prompt, relative cwd, and timeout.
  - `approval`: requests an interactive human decision and routes as `approved` or `rejected`.
- Supports ordered conditional edges: `success`, `failure`, `approved`, `rejected`, `output_contains`, and final `always` fallback.
- Passes state through `{{input}}`, `{{last_output}}`, and `{{outputs.<nodeId>}}` templates.
- Supports correction cycles with graph-wide `maxSteps` and per-node `maxVisits` safeguards.
- Propagates cancellation to LangGraph and running pi subprocesses.
- Streams node start/end/route progress through the pi tool update channel.
- Persists a compact execution trace as a pi session entry.
- Requires project trust and interactive confirmation when a model invokes a project-controlled graph. An explicit `/agent-graph run` command is treated as the user's approval.
- Prevents graph node cwd values from escaping the project root and caps definition/process/node output sizes.

## Commands and tool

```text
/agent-graph list
/agent-graph show <name>
/agent-graph validate <name>
/agent-graph run <name> <input>
```

The LLM-callable tool is:

```text
agent_graph_run({ graph, input })
```

Copy and adapt the example:

```bash
mkdir -p .pi/agent-graphs
cp packages/coding-agent/examples/extensions/agent-graph/example.graph.json .pi/agent-graphs/implement-review.json
./pi-test.sh -e packages/coding-agent/examples/extensions/agent-graph/index.ts
```

Run the deterministic regression:

```bash
./node_modules/.bin/tsx packages/coding-agent/examples/extensions/agent-graph/scripts/e2e-test.ts
```

## Boundaries

- This version uses one selected outgoing edge per node; parallel fan-out/fan-in is not yet exposed in the JSON schema.
- Agent nodes have isolated context and communicate through bounded textual outputs, not shared in-process conversation state.
- Completed run traces are persisted, but mid-node crash recovery and durable checkpoint resume are not yet exposed.
- Project graph definitions can instruct agents to use powerful tools. Trust and confirmation are security boundaries, not a substitute for Sandbox.

Reference: [LangGraph.js Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api).
