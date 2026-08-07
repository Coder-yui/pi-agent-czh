/**
 * A2A (Agent2Agent) Protocol extension for pi.
 *
 * Two capabilities:
 *  (1) A2A Server — expose pi as an A2A agent over HTTP+JSON-RPC, so other
 *      agents can discover it via /.well-known/agent-card.json and send tasks.
 *  (2) A2A Client — register `a2a_delegate` and `a2a_discover` tools that let
 *      pi send subtasks to remote A2A agents and collect their results.
 *
 * Commands:
 *   /a2a start [port]  — start A2A server (default port 41241)
 *   /a2a stop          — stop the server
 *   /a2a status        — show server status
 *   /a2a discover <url> — fetch and display a remote agent card
 *
 * Reference: https://a2a-protocol.org/  (A2A Protocol v1.0, Linux Foundation)
 * SDK: @a2a-js/sdk ^1.0.1 (official TypeScript SDK)
 */

import { randomUUID } from "node:crypto";
import express from "express";
import {
  A2A_PROTOCOL_VERSION,
  type AgentCard,
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type Task,
  type TaskStatusUpdateEvent,
  type TaskArtifactUpdateEvent,
  type Artifact,
  type Message,
  type Part,
  type TaskStatus,
} from "@a2a-js/sdk";
import {
  InMemoryTaskStore,
  DefaultRequestHandler,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
  AgentEvent,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { ClientFactory } from "@a2a-js/sdk/client";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    filename: "",
    mediaType: "text/plain",
    metadata: undefined,
  };
}

function extractTextFromMessage(message: Message): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === "text") {
      parts.push(part.content.value);
    }
  }
  const text = parts.join("\n\n").trim();
  return text || "(empty message)";
}

function extractTextFromArtifact(artifact: Artifact): string {
  const parts: string[] = [];
  for (const part of artifact.parts) {
    if (part.content?.$case === "text") parts.push(part.content.value);
  }
  return parts.join("\n").trim();
}

function extractTextFromTask(task: Task): string {
  // Collect text from all artifacts
  const texts: string[] = [];
  if (task.artifacts) {
    for (const art of task.artifacts) {
      const t = extractTextFromArtifact(art);
      if (t) texts.push(t);
    }
  }
  return texts.join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Agent Card for pi
// ---------------------------------------------------------------------------

function createPiAgentCard(port: number): AgentCard {
  return {
    name: "pi Coding Agent",
    description:
      "pi is a terminal-first AI coding agent. It can read/write files, run bash commands, edit code, and complete software engineering tasks. This A2A endpoint accepts text-based coding tasks and returns results.",
    supportedInterfaces: [
      {
        url: `http://localhost:${port}/`,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: "pi-agent-czh",
      url: "https://github.com/Coder-yui/pi-agent-czh",
    },
    version: "0.1.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "task-status"],
    skills: [
      {
        id: "coding",
        name: "Code Writing & Editing",
        description:
          "Write, edit, debug, and refactor code in any programming language. Currently responds via direct model inference (no tool execution in A2A mode v0.1).",
        tags: ["coding", "programming", "debugging", "refactoring"],
        examples: [
          "Write a Python function to parse CSV files",
          "Explain what this code does",
          "Suggest a refactoring approach",
        ],
        inputModes: ["text"],
        outputModes: ["text", "task-status"],
        securityRequirements: [],
      },
    ],
    documentationUrl: "https://github.com/Coder-yui/pi-agent-czh",
    signatures: [],
  };
}

// ---------------------------------------------------------------------------
// AgentExecutor: bridges A2A tasks → pi model responses
// ---------------------------------------------------------------------------

class PiA2AExecutor implements AgentExecutor {
  private cancelledTasks = new Set<string>();
  private getModel: () => any;

  constructor(getModel: () => any) {
    this.getModel = getModel;
  }

  cancelTask = async (taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    this.cancelledTasks.add(taskId);
  };

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage;
    const existingTask = requestContext.task;
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;

    try {
      // 1. Publish initial Task snapshot (required as first event)
      const initialStatus: TaskStatus = {
        state: TaskState.TASK_STATE_SUBMITTED,
        timestamp: new Date().toISOString(),
      };
      const taskSnapshot: Task = existingTask ?? {
        id: taskId,
        contextId,
        status: initialStatus,
        artifacts: [],
        history: [userMessage],
        metadata: userMessage.metadata,
      };
      eventBus.publish(AgentEvent.task(taskSnapshot));

      // 2. Publish working status
      const workingStatusMsg: Message = {
        role: Role.ROLE_AGENT,
        messageId: randomUUID(),
        contextId,
        taskId,
        parts: [textPart("Processing your request with pi...")],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      };
      const workingUpdate: TaskStatusUpdateEvent = {
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: workingStatusMsg,
          timestamp: new Date().toISOString(),
        },
        metadata: {},
      };
      eventBus.publish(AgentEvent.statusUpdate(workingUpdate));

      if (this.cancelledTasks.has(taskId)) {
        this.publishCanceled(eventBus, taskId, contextId);
        return;
      }

      // 3. Extract text and call the model
      const userText = extractTextFromMessage(userMessage);
      const model = this.getModel();
      if (!model) {
        const errText =
          "A2A server running but no model is selected. Start pi with a configured model provider to respond to tasks.";
        this.publishErrorArtifact(eventBus, taskId, contextId, errText);
        this.publishCompleted(eventBus, taskId, contextId);
        return;
      }

      const systemPrompt = `You are pi, a terminal-first AI coding agent exposed via the A2A (Agent2Agent) protocol.
You are responding to a task delegated to you by another agent.
Provide clear, concise, actionable responses. If the task involves code, write correct, well-structured code.
Be direct and helpful. Do not include unnecessary preamble.`;

      let responseText = "";
      try {
        // Try streaming first; fall back to non-streaming complete
        if (typeof model.completeStream === "function") {
          const chunks: string[] = [];
          const stream = model.completeStream(
            {
              systemPrompt,
              messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
            },
            { signal: AbortSignal.timeout(120000) },
          );
          for await (const chunk of stream) {
            if (this.cancelledTasks.has(taskId)) break;
            const delta =
              typeof chunk === "string" ? chunk : chunk?.delta ?? chunk?.text ?? "";
            if (delta) chunks.push(delta);
          }
          responseText = chunks.join("");
        } else {
          const result = await model.complete(
            {
              systemPrompt,
              messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
            },
            { signal: AbortSignal.timeout(120000) },
          );
          responseText =
            result.content
              ?.filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n") ?? "";
        }
      } catch (err: any) {
        responseText = `Error processing task: ${err?.message ?? String(err)}`;
      }

      if (this.cancelledTasks.has(taskId)) {
        this.publishCanceled(eventBus, taskId, contextId);
        return;
      }

      if (!responseText.trim()) {
        responseText = "(empty response from model)";
      }

      // 4. Publish result artifact
      const artifact: Artifact = {
        artifactId: randomUUID(),
        name: "Result",
        description: "pi's response to the task",
        parts: [textPart(responseText)],
        extensions: [],
      };
      const artifactUpdate: TaskArtifactUpdateEvent = {
        taskId,
        contextId,
        artifact,
        lastChunk: true,
        append: false,
      };
      eventBus.publish(AgentEvent.artifactUpdate(artifactUpdate));

      // 5. Publish completed status
      this.publishCompleted(eventBus, taskId, contextId);
    } finally {
      this.cancelledTasks.delete(taskId);
    }
  }

  private publishCanceled(eventBus: ExecutionEventBus, taskId: string, contextId: string) {
    const update: TaskStatusUpdateEvent = {
      taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString() },
      metadata: {},
    };
    eventBus.publish(AgentEvent.statusUpdate(update));
  }

  private publishCompleted(eventBus: ExecutionEventBus, taskId: string, contextId: string) {
    const update: TaskStatusUpdateEvent = {
      taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() },
      metadata: {},
    };
    eventBus.publish(AgentEvent.statusUpdate(update));
  }

  private publishErrorArtifact(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    errorText: string,
  ) {
    const artifact: Artifact = {
      artifactId: randomUUID(),
      name: "Error",
      description: "Error information",
      parts: [textPart(errorText)],
      extensions: [],
    };
    eventBus.publish(
      AgentEvent.artifactUpdate({ taskId, contextId, artifact, lastChunk: true, append: false }),
    );
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

interface A2AServerState {
  app: express.Express;
  server: ReturnType<express.Express["listen"]>;
  port: number;
}

const DELEGATE_PARAMS = Type.Object({
  agent_url: Type.String({
    description: "Base URL of the remote A2A agent (e.g. http://localhost:41241)",
  }),
  task: Type.String({
    description: "Description of the task to delegate to the remote agent",
  }),
  context: Type.Optional(
    Type.String({
      description: "Optional additional context to provide to the remote agent",
    }),
  ),
});

const DISCOVER_PARAMS = Type.Object({
  agent_url: Type.String({ description: "Base URL of the remote A2A agent" }),
});

export default function a2aExtension(pi: ExtensionAPI) {
  let serverState: A2AServerState | null = null;

  // Try to access the current model from pi's runtime.
  // Extensions loaded via -e have access to pi's session; we try common access paths.
  const getCurrentModel = (): any => {
    // Pi sessions typically expose model via session.model or the runtime.
    // We try a few access patterns; if none work, the executor will return an error.
    const session = (pi as any).session;
    if (session?.model) return session.model;
    if (session?.modelRuntime) {
      try {
        const def = session.modelRuntime.getDefaultModel?.();
        if (def) return def;
      } catch { /* noop */ }
    }
    const runtime = (pi as any).modelRuntime;
    if (runtime) {
      try { return runtime.getDefaultModel?.() ?? null; } catch { /* noop */ }
    }
    return null;
  };

  // ---- Tools ----

  pi.registerTool({
    name: "a2a_delegate",
    label: "A2A Delegate Task",
    description:
      "Delegate a subtask to a remote A2A (Agent2Agent) agent. Discovers the agent's card from its URL, sends the task via JSON-RPC streaming, collects status updates and artifacts, and returns the final result. Use this when you want another agent to do work for you.",
    promptSnippet: "Delegate a subtask to a remote A2A agent at the given URL",
    promptGuidelines: [
      "Use a2a_delegate when a task would benefit from a specialized remote agent.",
      "Provide a clear, self-contained task description with all necessary context.",
      "The agent_url must be a reachable HTTP base URL (the agent card is at /.well-known/agent-card.json).",
    ],
    parameters: DELEGATE_PARAMS,
    async execute(_toolCallId, params) {
      const { agent_url, task, context } = params;
      try {
        const clientFactory = new ClientFactory();
        const client = await clientFactory.createFromUrl(agent_url);

        const messageText = context ? `${task}\n\nAdditional context:\n${context}` : task;
        const userMessage: Message = {
          role: Role.ROLE_USER,
          messageId: randomUUID(),
          contextId: "",
          taskId: "",
          parts: [textPart(messageText)],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        };

        let finalText = "";
        const statusLines: string[] = [];

        try {
          const stream = client.sendMessageStream({ message: userMessage });
          for await (const resp of stream) {
            const kind = resp.payload?.$case;
            if (!kind) continue;
            if (kind === "statusUpdate") {
              const evt = resp.payload.value;
              const state = evt.status?.state ?? "unknown";
              let msg = "";
              if (evt.status?.message?.parts) {
                msg = evt.status.message.parts
                  .filter((p) => p.content?.$case === "text")
                  .map((p) => (p.content as any).value)
                  .join(" ");
              }
              if (msg) statusLines.push(`- [${state}] ${msg}`);
            } else if (kind === "artifactUpdate") {
              const art = resp.payload.value.artifact;
              if (art) {
                const t = extractTextFromArtifact(art);
                if (t) finalText += (finalText ? "\n\n" : "") + t;
              }
            } else if (kind === "task") {
              const t = extractTextFromTask(resp.payload.value);
              if (t) finalText = t;
            } else if (kind === "message") {
              const m = resp.payload.value;
              const txt = m.parts
                .filter((p) => p.content?.$case === "text")
                .map((p) => (p.content as any).value)
                .join("\n");
              if (txt) finalText += (finalText ? "\n" : "") + txt;
            }
          }
        } catch (streamErr: any) {
          // Fallback to non-streaming
          const result = await client.sendMessage({ message: userMessage });
          if ("artifacts" in result && result.artifacts) {
            for (const art of result.artifacts) {
              const t = extractTextFromArtifact(art);
              if (t) finalText += (finalText ? "\n\n" : "") + t;
            }
          } else if ("parts" in result) {
            finalText = result.parts
              .filter((p) => p.content?.$case === "text")
              .map((p) => (p.content as any).value)
              .join("\n");
          }
        }

        const lines = [
          `### Delegated to A2A agent: ${client.agentCard.name}`,
          "",
          `**URL:** ${agent_url}`,
          `**Agent description:** ${client.agentCard.description ?? "(none)"}`,
          "",
        ];
        if (statusLines.length > 0) {
          lines.push("**Status updates:**", ...statusLines, "");
        }
        lines.push("**Result:**", finalText || "(no text result returned)");

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agent_url, task_sent: task },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to delegate to A2A agent at ${agent_url}: ${err?.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "a2a_discover",
    label: "A2A Discover Agent",
    description:
      "Discover a remote A2A agent by fetching and displaying its agent card. Shows name, description, skills, capabilities, and supported protocols. Use this before delegating to understand what the agent can do.",
    promptSnippet: "Discover a remote A2A agent's capabilities",
    parameters: DISCOVER_PARAMS,
    async execute(_toolCallId, params) {
      try {
        const clientFactory = new ClientFactory();
        const client = await clientFactory.createFromUrl(params.agent_url);
        const card = client.agentCard;

        const info = [
          `### A2A Agent: ${card.name}`,
          "",
          `**Description:** ${card.description ?? "(none)"}`,
          `**Version:** ${card.version ?? "unknown"}`,
          `**Protocol version:** ${A2A_PROTOCOL_VERSION}`,
          `**Provider:** ${card.provider?.organization ?? "unknown"}`,
          "",
          "**Capabilities:**",
          `- Streaming: ${card.capabilities?.streaming ? "yes" : "no"}`,
          `- Push notifications: ${card.capabilities?.pushNotifications ? "yes" : "no"}`,
          "",
          "**Skills:**",
          ...(card.skills?.map(
            (s) =>
              `- **${s.name}** (${s.id}): ${s.description}${s.tags?.length ? ` [tags: ${s.tags.join(", ")}]` : ""}`,
          ) ?? ["(none)"]),
          "",
          "**Interfaces:**",
          ...(card.supportedInterfaces?.map(
            (i) => `- ${i.protocolBinding} @ ${i.url} (v${i.protocolVersion})`,
          ) ?? ["(none)"]),
        ].join("\n");

        return { content: [{ type: "text", text: info }] };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to discover agent at ${params.agent_url}: ${err?.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ---- Commands ----

  pi.registerCommand("a2a", {
    description: "A2A protocol control: /a2a start [port] | stop | status | discover <url>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcmd = (parts[0] ?? "status").toLowerCase();

      if (subcmd === "start" || subcmd === "on") {
        if (serverState) {
          ctx.ui.notify(`A2A server already running on port ${serverState.port}`, "warning");
          return;
        }
        const port = parseInt(parts[1] ?? "41241", 10);
        if (Number.isNaN(port) || port < 1 || port > 65535) {
          ctx.ui.notify(`Invalid port: ${parts[1]}`, "error");
          return;
        }
        try {
          serverState = startServer(getCurrentModel, port);
          ctx.ui.notify(`A2A server started on http://localhost:${port}`, "info");
          ctx.ui.notify(`Agent card: http://localhost:${port}${AGENT_CARD_PATH}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed to start A2A server: ${err?.message ?? String(err)}`, "error");
          serverState = null;
        }
        return;
      }

      if (subcmd === "stop" || subcmd === "off") {
        if (!serverState) {
          ctx.ui.notify("A2A server is not running", "warning");
          return;
        }
        await new Promise<void>((resolve) => {
          serverState!.server.close(() => resolve());
        });
        ctx.ui.notify(`A2A server stopped (was on port ${serverState.port})`, "info");
        serverState = null;
        return;
      }

      if (subcmd === "discover") {
        const url = parts[1];
        if (!url) {
          ctx.ui.notify("Usage: /a2a discover <agent-url>", "warning");
          return;
        }
        try {
          ctx.ui.notify(`Discovering A2A agent at ${url}...`, "info");
          const clientFactory = new ClientFactory();
          const client = await clientFactory.createFromUrl(url);
          const card = client.agentCard;
          ctx.ui.notify(`Agent: ${card.name} (v${card.version ?? "?"})`, "info");
          ctx.ui.notify(`Description: ${card.description ?? "(none)"}`, "info");
          ctx.ui.notify(
            `Skills: ${card.skills?.map((s) => s.name).join(", ") ?? "(none)"}`,
            "info",
          );
          ctx.ui.notify(`Streaming: ${card.capabilities?.streaming ? "yes" : "no"}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Discovery failed: ${err?.message ?? String(err)}`, "error");
        }
        return;
      }

      // status (default)
      if (serverState) {
        ctx.ui.notify(`A2A server: RUNNING on http://localhost:${serverState.port}`, "info");
        ctx.ui.notify(`Agent card: http://localhost:${serverState.port}${AGENT_CARD_PATH}`, "info");
      } else {
        ctx.ui.notify("A2A server: STOPPED. Use /a2a start [port] to start.", "info");
      }
      ctx.ui.notify("Registered tools: a2a_delegate, a2a_discover", "info");
    },
  });

  // ---- Lifecycle ----
  pi.on("session_shutdown", async () => {
    if (serverState) {
      await new Promise<void>((resolve) => {
        serverState!.server.close(() => resolve());
      });
      serverState = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

function startServer(getModel: () => any, port: number): A2AServerState {
  const agentCard = createPiAgentCard(port);
  const taskStore = new InMemoryTaskStore();
  const executor = new PiA2AExecutor(getModel);
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(`/${AGENT_CARD_PATH.replace(/^\//, "")}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  const server = app.listen(port);

  return { app, server, port };
}
