/** End-to-end test for the real A2A extension entrypoint. */
import { randomUUID } from "node:crypto";
import { ClientFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import a2aExtension from "../index.ts";

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const notifications = [];
const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
};

a2aExtension(pi);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`  ✓ ${message}`);
}

function textPart(text) {
  return { content: { $case: "text", value: text }, filename: "", mediaType: "text/plain", metadata: undefined };
}

async function main() {
  const port = 41299;
  const model = { provider: "faux", id: "a2a-test" };
  const modelRegistry = {
    stream(_model, context, options) {
      const text = context.messages.at(-1)?.content?.find((part) => part.type === "text")?.text ?? "";
      const response = `[mock-pi] ${text}`;
      return {
        async *[Symbol.asyncIterator]() {
          if (text === "Slow task") {
            await new Promise((resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            });
          }
          if (text === "Fail task") {
            yield {
              type: "error",
              reason: "error",
              error: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "forced model failure",
                timestamp: Date.now(),
              },
            };
            return;
          }
          const split = Math.ceil(response.length / 2);
          yield { type: "text_delta", contentIndex: 0, delta: response.slice(0, split), partial: undefined };
          yield { type: "text_delta", contentIndex: 0, delta: response.slice(split), partial: undefined };
          yield {
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text: response }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
          };
        },
      };
    },
  };
  const ctx = {
    model,
    modelRegistry,
    ui: {
      notify(message) { notifications.push(message); },
    },
  };

  for (const handler of handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }

  const command = commands.get("a2a");
  assert(command, "real extension registered /a2a command");
  assert(tools.has("a2a_delegate") && tools.has("a2a_discover"), "real extension registered client tools");
  await command.handler(`start ${port}`, ctx);

  try {
    const url = `http://127.0.0.1:${port}`;
    const client = await new ClientFactory().createFromUrl(url);
    const card = await client.getAgentCard();
    assert(card.name === "pi Coding Agent", "agent card is served by the real extension");
    assert(!card.description.includes("run bash"), "agent card does not claim unavailable shell or filesystem access");

    const message = {
      role: Role.ROLE_USER,
      messageId: randomUUID(),
      contextId: "",
      taskId: "",
      parts: [textPart("Hello through A2A")],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    };
    const events = [];
    let finalText = "";
    for await (const response of client.sendMessageStream({
      tenant: "",
      message,
      configuration: undefined,
      metadata: undefined,
    })) {
      const payload = response.payload;
      if (!payload) continue;
      events.push(payload.$case);
      if (payload.$case === "artifactUpdate") {
        for (const part of payload.value.artifact?.parts ?? []) {
          if (part.content?.$case === "text") finalText += part.content.value;
        }
      }
    }
    assert(events.includes("task"), "stream contains a task snapshot");
    assert(events.includes("statusUpdate"), "stream contains status updates");
    assert(events.includes("artifactUpdate"), "stream contains an artifact");
    assert(events.filter((event) => event === "artifactUpdate").length >= 2, "model deltas are exposed as A2A artifact chunks");
    assert(finalText === "[mock-pi] Hello through A2A", "inbound task used pi's current model registry");

    const failedStates = [];
    for await (const response of client.sendMessageStream({
      tenant: "",
      message: { ...message, messageId: randomUUID(), parts: [textPart("Fail task")] },
      configuration: undefined,
      metadata: undefined,
    })) {
      if (response.payload?.$case === "statusUpdate") failedStates.push(response.payload.value.status.state);
    }
    assert(failedStates.at(-1) === 4, "model failures terminate the A2A task as FAILED");

    const cancelStream = client.sendMessageStream({
      tenant: "",
      message: { ...message, messageId: randomUUID(), parts: [textPart("Slow task")] },
      configuration: undefined,
      metadata: undefined,
    });
    const cancelStates = [];
    let cancellationRequested = false;
    for await (const response of cancelStream) {
      if (response.payload?.$case === "task" && !cancellationRequested) {
        cancellationRequested = true;
        await client.cancelTask({ tenant: "", id: response.payload.value.id, metadata: undefined });
      }
      if (response.payload?.$case === "statusUpdate") cancelStates.push(response.payload.value.status.state);
    }
    assert(cancelStates.at(-1) === 5, "A2A cancellation aborts model execution and terminates as CANCELED");

    const discover = await tools.get("a2a_discover").execute("discover", { agent_url: url });
    assert(discover.content[0].text.includes("pi Coding Agent"), "a2a_discover uses the real client adapter");

    const delegated = await tools.get("a2a_delegate").execute("delegate", {
      agent_url: url,
      task: "Delegated task",
    });
    assert(delegated.content[0].text.includes("[mock-pi] Delegated task"), "a2a_delegate completes a real round trip");
  } finally {
    await command.handler("stop", ctx);
  }

  console.log(`\nResults: ${passed} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
