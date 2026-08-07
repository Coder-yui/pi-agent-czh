/**
 * Self-contained A2A roundtrip test.
 *
 * Spins up the pi A2A server with a mock model, then uses the A2A client SDK
 * to discover the agent card, send a task via streaming, and verify the response.
 *
 * Run with: node --experimental-strip-types scripts/test-a2a.mjs
 */

import express from "express";
import { randomUUID } from "node:crypto";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  Role,
  TaskState,
} from "@a2a-js/sdk";
import {
  InMemoryTaskStore,
  DefaultRequestHandler,
  AgentEvent,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { ClientFactory } from "@a2a-js/sdk/client";

// ---- Mock model: echoes back the prompt ----
function createMockModel() {
  return {
    async complete({ messages, systemPrompt }) {
      const lastUser = messages
        .filter((m) => m.role === "user")
        .pop();
      const text = lastUser?.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
      return {
        content: [
          { type: "text", text: `[mock-pi] I received your message: "${text.slice(0, 100)}". System prompt length: ${systemPrompt?.length ?? 0}` },
        ],
      };
    },
  };
}

// ---- Inline executor logic (mirrors PiA2AExecutor but simplified for test) ----
function textPart(text) {
  return {
    content: { $case: "text", value: text },
    filename: "",
    mediaType: "text/plain",
    metadata: undefined,
  };
}

function extractTextFromMessage(message) {
  const parts = [];
  for (const part of message.parts) {
    if (part.content?.$case === "text") parts.push(part.content.value);
  }
  return parts.join("\n\n").trim() || "(empty)";
}

class TestExecutor {
  constructor(model) { this.model = model; this.cancelled = new Set(); }
  cancelTask = async (taskId) => { this.cancelled.add(taskId); };

  async execute(ctx, bus) {
    const userMsg = ctx.userMessage;
    const taskId = ctx.taskId;
    const contextId = ctx.contextId;

    try {
      // 1. Initial task snapshot
      bus.publish(AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [userMsg],
        metadata: userMsg.metadata,
      }));

      // 2. Working status
      bus.publish(AgentEvent.statusUpdate({
        taskId, contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: {
            role: Role.ROLE_AGENT, messageId: randomUUID(), contextId, taskId,
            parts: [textPart("Working on it...")],
            metadata: {}, extensions: [], referenceTaskIds: [],
          },
          timestamp: new Date().toISOString(),
        },
        metadata: {},
      }));

      // 3. Call model
      const userText = extractTextFromMessage(userMsg);
      const result = await this.model.complete({
        systemPrompt: "You are a test agent.",
        messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      });
      const respText = result.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";

      // 4. Artifact
      bus.publish(AgentEvent.artifactUpdate({
        taskId, contextId,
        artifact: {
          artifactId: randomUUID(),
          name: "Result",
          description: "",
          parts: [textPart(respText)],
          extensions: [],
        },
        lastChunk: true,
        append: false,
      }));

      // 5. Completed
      bus.publish(AgentEvent.statusUpdate({
        taskId, contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() },
        metadata: {},
      }));
    } finally {
      this.cancelled.delete(taskId);
    }
  }
}

function startTestServer(port, model) {
  const card = {
    name: "pi Test Agent",
    description: "Test instance of pi A2A server",
    supportedInterfaces: [{ url: `http://localhost:${port}/`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "test" },
    version: "test",
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {}, securityRequirements: [],
    defaultInputModes: ["text"], defaultOutputModes: ["text", "task-status"],
    skills: [{ id: "test", name: "Test", description: "echo", tags: [], examples: [], inputModes: ["text"], outputModes: ["text"], securityRequirements: [] }],
    signatures: [],
  };
  const store = new InMemoryTaskStore();
  const executor = new TestExecutor(model);
  const handler = new DefaultRequestHandler(card, store, executor);

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const cardPath = AGENT_CARD_PATH.replace(/^\//, "");
  app.use(`/${cardPath}`, agentCardHandler({ agentCardProvider: handler }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  const server = app.listen(port);
  return { server, port, url: `http://localhost:${port}` };
}

// ---- Run tests ----
let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.log(`  ✗ ${msg}`); failed++; }
}

async function main() {
  const port = 41299;
  console.log(`Starting test A2A server on port ${port}...`);
  const model = createMockModel();
  const { server, url } = startTestServer(port, model);

  // Wait for server to be ready
  await new Promise((r) => server.once("listening", r));

  try {
    console.log("\n[Test 1] Agent card discovery");
    const factory = new ClientFactory();
    const client = await factory.createFromUrl(url);
    assert(client.agentCard.name === "pi Test Agent", `Card name is "${client.agentCard.name}"`);
    assert(client.agentCard.capabilities.streaming === true, "Card advertises streaming");
    assert(client.agentCard.skills.length === 1, `Card has ${client.agentCard.skills.length} skill(s)`);

    console.log("\n[Test 2] Send message (streaming)");
    const userMessage = {
      role: Role.ROLE_USER, messageId: randomUUID(),
      contextId: "", taskId: "",
      parts: [textPart("Hello, pi! Tell me a short joke about programming.")],
      metadata: {}, extensions: [], referenceTaskIds: [],
    };

    const events = [];
    let finalText = "";
    const stream = client.sendMessageStream({ message: userMessage });
    for await (const resp of stream) {
      const kind = resp.payload?.$case;
      events.push(kind);
      if (kind === "artifactUpdate") {
        for (const p of resp.payload.value.artifact.parts) {
          if (p.content?.$case === "text") finalText += p.content.value;
        }
      }
    }

    assert(events.includes("task"), "Stream includes 'task' event");
    assert(events.includes("statusUpdate"), "Stream includes 'statusUpdate' event");
    assert(events.includes("artifactUpdate"), "Stream includes 'artifactUpdate' event");
    assert(finalText.includes("mock-pi"), `Result mentions mock-pi: "${finalText.slice(0, 80)}..."`);
    assert(finalText.includes("Hello, pi!"), "Result echoes user input");

    console.log("\n[Test 3] Send message (non-streaming fallback)");
    const userMessage2 = {
      role: Role.ROLE_USER, messageId: randomUUID(),
      contextId: "", taskId: "",
      parts: [textPart("What is 2+2?")],
      metadata: {}, extensions: [], referenceTaskIds: [],
    };
    const result2 = await client.sendMessage({ message: userMessage2 });
    let text2 = "";
    if (result2.artifacts) {
      for (const art of result2.artifacts) {
        for (const p of art.parts) {
          if (p.content?.$case === "text") text2 += p.content.value;
        }
      }
    }
    assert(text2.includes("mock-pi"), `Non-streaming result works: "${text2.slice(0, 80)}..."`);

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
  } catch (err) {
    console.error("TEST ERROR:", err);
    failed++;
  } finally {
    server.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
