# Phase 6: Agent Loop + Agent Graph

> Code:
> - [Agent Loop](../../packages/coding-agent/examples/extensions/agent-loop/)
> - [Agent Graph](../../packages/coding-agent/examples/extensions/agent-graph/)

This phase adds two orchestration layers without replacing pi's existing agent runtime. Agent Loop controls repeated full-session runs. Agent Graph composes isolated pi agents into a validated state graph.

## Agent Loop

### Mature reference and adaptation

The control semantics follow [Google ADK LoopAgent](https://google.github.io/adk-docs/agents/workflow-agents/loop-agents/): sequential iterations, an explicit sub-agent termination signal, and `maxIterations` as the final infinite-loop guard. Directly embedding Google ADK would replace pi's provider/tool/session stack, so the adapter implements only the LoopAgent control contract on pi lifecycle events.

### What is implemented

| Capability | Implementation |
|---|---|
| Full agent iterations | Every iteration is a normal pi AgentSession run with all active tools/extensions |
| Explicit termination | `agent_loop_checkpoint` records `continue`, `complete`, or `blocked` with evidence |
| Automatic continuation | A valid `continue` queues exactly one follow-up run after `agent_end` |
| Hard budgets | Maximum iterations, attempted tool calls, and wall-clock deadline |
| Fail-closed behavior | Missing checkpoint pauses; exhausted budget stops; reload pauses instead of auto-resuming |
| Persistence | State and checkpoint history are pi custom session entries and follow the active session branch |
| User control | `/agent-loop start/status/pause/resume/stop` |
| Regression | Real AgentSession + faux provider verifies continuation, completion, missing checkpoint, iteration limit, and tool-call limit |

The model cannot start a loop through a tool. Only the user-facing command creates one.

## Agent Graph

### Mature implementation used directly

Graph execution uses [`@langchain/langgraph@1.4.9`](https://github.com/langchain-ai/langgraphjs) and its real `StateGraph`, rather than a local graph scheduler. Zod validates the project JSON adapter schema.

### What is implemented

| Capability | Implementation |
|---|---|
| Graph model | Versioned nodes, ordered conditional edges, entrypoint, cycles, graph `maxSteps`, node `maxVisits` |
| Stateful execution | LangGraph Annotation channels retain outputs, visits, last result, and trace |
| Agent nodes | Isolated full pi subprocess with optional model/tools/system prompt/relative cwd/timeout |
| Human nodes | Interactive approval node producing `approved` or `rejected` routing status |
| Conditions | `success`, `failure`, `approved`, `rejected`, `output_contains`, `always` fallback |
| State templates | `{{input}}`, `{{last_output}}`, `{{outputs.<nodeId>}}` |
| Validation | Duplicate/unreachable nodes, invalid targets, fallback ordering, identifiers, graph size limits |
| Cancellation | AbortSignal reaches LangGraph and terminates a running pi subprocess |
| Observability | Streaming node/route updates plus compact persisted session trace |
| Security | Project trust, tool-call confirmation, relative-cwd containment, file/output caps |
| Regression | Real StateGraph correction cycle, recursion exhaustion, cancellation, schema rejection, and real extension tool wiring |

### Definition example

The checked-in [example.graph.json](../../packages/coding-agent/examples/extensions/agent-graph/example.graph.json) implements:

```text
implement -> review -> approval -> end
     ^          |
     +----------+  when review says CHANGES_REQUIRED
```

## Honest boundaries

- Loop completion is evidence-backed model judgment, not formal proof.
- Graph v0.1 selects one outgoing edge. Parallel fan-out/fan-in is not exposed yet.
- Graph agent nodes share bounded textual state, not a common live context window.
- Graph traces persist after a run, but durable mid-run checkpoint resume is not exposed yet.
- Agent Graph orchestrates powerful pi processes; Sandbox remains the execution-isolation layer.
