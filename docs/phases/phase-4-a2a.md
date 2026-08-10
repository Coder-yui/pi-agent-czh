# Phase 4: A2A Protocol — Agent Interoperability

> **Implementation date:** 2026-04-07
> **Status:** ✅ Complete (v0.1)
> **Location:** `packages/coding-agent/examples/extensions/a2a/`

## Overview

Phase 4 implements the [A2A (Agent2Agent) Protocol](https://a2a-protocol.org/) v1.0 (Linux Foundation open standard) for pi, enabling **interoperability between pi and other AI agents**. This gives pi two new capabilities:

1. **Act as an A2A Server** — pi can receive tasks from other A2A-compatible agents (exposing an HTTP+JSON-RPC endpoint with a discoverable agent card).
2. **Act as an A2A Client** — pi can delegate subtasks to remote A2A agents and incorporate their results into its own work.

## What is A2A?

A2A is an open protocol for communication between AI agents, designed to solve the problem of agent interoperability. Key concepts:

- **Agent Card**: A standardized JSON document served at `/.well-known/agent-card.json` that describes an agent's name, description, skills, capabilities, and transport endpoints.
- **Task Lifecycle**: Tasks go through states `submitted → working → completed/failed/canceled`, with streaming status updates and `artifacts` (outputs).
- **Message Parts**: Content is structured as Parts that can contain text, files (raw bytes), URLs, or structured data.
- **Streaming**: SSE/JSON-RPC streaming for real-time status updates and incremental artifact delivery.
- **Multi-transport**: Supports JSON-RPC over HTTP, REST, and gRPC.

## Implementation

### Dependencies

- **`@a2a-js/sdk@1.0.1`** — Official TypeScript SDK from the A2A project
- **`express@4.22.2`** — HTTP server for the A2A JSON-RPC endpoint

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        pi (main process)                    │
│                                                             │
│  ┌──────────────────┐    ┌───────────────────────────────┐  │
│  │  A2A Client      │    │  A2A Server (Express :41241)  │  │
│  │  (delegate tool) │    │                               │  │
│  │                  │    │  /.well-known/agent-card.json │  │
│  │  a2a_discover    │───▶│  JSON-RPC endpoint            │  │
│  │  a2a_delegate    │    │         │                     │  │
│  └──────────────────┘    │         ▼                     │  │
│          │               │  PiA2AExecutor                │  │
│          │ calls remote  │    ├─ publishes task snapshot  │  │
│          │ agents        │    ├─ streams status updates   │  │
│          ▼               │    └─ returns result artifact  │  │
│  ┌──────────────────┐    │         │                     │  │
│  │  Other A2A       │    │         ▼                     │  │
│  │  Agents          │    │  pi Model (current session)   │  │
│  └──────────────────┘    └───────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Files

| File | Purpose |
|------|---------|
| `extensions/a2a/package.json` | Extension dependencies |
| `extensions/a2a/index.ts` | Main extension: server + client tools + commands |
| `extensions/a2a/scripts/test-a2a.mjs` | Self-contained SDK-level E2E test |

### Server: `PiA2AExecutor`

The `PiA2AExecutor` class implements A2A's `AgentExecutor` interface:

1. **`execute()`** — Called when a task arrives. It:
   - Publishes an initial `task` snapshot (required by the SDK as the first event)
   - Publishes a `working` status update
   - Extracts text from the user message
   - Calls pi's currently selected model through the public ModelRegistry streaming facade
   - Publishes model deltas as ordered chunks of one A2A artifact (`append`/`lastChunk` semantics preserved)
	- Publishes a `completed` status update
	- Publishes `failed` on model errors; `cancelTask()` aborts the real model stream and publishes `canceled`

2. **Agent Card** — Advertises the actual direct-model text/coding-advice boundary and streaming JSON-RPC transport. It deliberately does not claim bash or filesystem access because inbound A2A tasks do not create a full AgentSession.

### Client: Registered Tools

Two tools are registered with pi's tool system and available to the LLM during any session:

#### `a2a_delegate`
```json
{
  "agent_url": "string (required, e.g. http://localhost:41241)",
  "task": "string (required, description of work to delegate)",
  "context": "string (optional, additional context)"
}
```
Sends a task to a remote A2A agent using streaming JSON-RPC, collects status updates and correctly appends artifact chunks. Caller cancellation and timeout are passed through the SDK. It falls back to non-streaming only when the stream failed before yielding any protocol payload, avoiding duplicate task execution after partial delivery.

#### `a2a_discover`
```json
{ "agent_url": "string (required)" }
```
Fetches and displays a remote agent's card (name, description, version, skills, capabilities, interfaces). The LLM can use this to decide whether an agent is suitable for a task.

### Commands

| Command | Description |
|---------|-------------|
| `/a2a start [port]` | Start the A2A server (default port 41241) |
| `/a2a stop` | Stop the server |
| `/a2a status` | Show server status and registered tools |
| `/a2a discover <url>` | Fetch and display a remote agent card in the TUI |

## Usage

### Starting the A2A server

```bash
# Load the A2A extension along with other extensions:
pi -e extensions/memory.ts -e extensions/mcp.ts -e extensions/a2a/index.ts

# In pi's TUI, start the server:
/a2a start 41241
# → A2A server started on http://localhost:41241
# → Agent card: http://localhost:41241/.well-known/agent-card.json
```

### Delegating to another agent

Within a pi session, the LLM can now delegate:

```
User: Can you ask the math agent at http://localhost:42000 what 42 factorial is?

pi calls a2a_discover → learns it has a "math" skill
pi calls a2a_delegate(agent_url="http://localhost:42000", task="Calculate 42!")
→ Returns: "42! = 1405006117752879898543142606244511569936384000000000"
```

### Agent Card (example output)

```json
{
  "name": "pi Coding Agent",
  "description": "pi is a terminal-first AI coding agent...",
  "version": "0.1.0",
  "protocol_version": "1.0",
  "capabilities": { "streaming": true, "push_notifications": false },
  "skills": [{
    "id": "coding",
    "name": "Code Writing & Editing",
    "description": "Write, edit, debug, and refactor code...",
    "tags": ["coding", "programming", "debugging"]
  }],
  "url": "http://localhost:41241/"
}
```

## Test Results

The SDK-level test verifies Agent Card accuracy, multi-delta artifact chunks, failed model calls, real cancellation, discovery, and streaming/non-streaming round trips. The current suite has 13 passing assertions.

Run tests:
```bash
cd packages/coding-agent/examples/extensions/a2a
node scripts/test-a2a.mjs
```

## Limitations & Future Work

### Current v0.1 Limitations

1. **No tool execution in A2A server mode**: When pi receives a task via A2A, it calls the model directly without spawning a full `AgentSession` (no bash, no file editing in A2A tasks). This ensures reliability for v0.1.
2. **Model access**: The server relies on pi's session model being available. Missing models and model errors terminate the A2A task in `failed`, rather than returning an error-shaped artifact followed by `completed`.
3. **No authentication**: The server runs without auth (intended for local/dev use).
4. **Single-tenant**: All tasks share the same server instance.

### Future Enhancements

- **Full agent sessions in A2A tasks**: Spawn isolated `AgentSession` instances per task, enabling bash execution and file editing (like Phase 2's ACP adapter does).
- **Push notifications**: Support for task updates via webhooks.
- **Structured data parts**: Support for JSON/data parts beyond text.
- **gRPC transport**: Add gRPC transport alongside HTTP+JSON-RPC.
- **Multi-agent orchestration**: Add a tool for parallel delegation to multiple agents.

## Protocol Reference

- **Specification**: https://a2a-protocol.org/specification/
- **GitHub**: https://github.com/a2aproject/a2a
- **TypeScript SDK**: https://www.npmjs.com/package/@a2a-js/sdk
- **Python SDK**: `pip install a2a-sdk`
