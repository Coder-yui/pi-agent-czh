#!/usr/bin/env node
/**
 * pi-acp — stdio entry point.
 *
 * This is the binary spawned by ACP-compatible editors (Zed, etc.).
 * It wires PiAcpAgent to stdin/stdout via the ACP ndjson transport.
 *
 * Run directly with: npx tsx packages/coding-agent/examples/extensions/acp/index.ts
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { buildAgentApp } from "./lib.ts";

const stdoutWeb = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
const stdinWeb = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(stdoutWeb, stdinWeb);

buildAgentApp().connect(stream);

// Keep process alive; connection closes on stdin EOF.
await new Promise(() => {});
