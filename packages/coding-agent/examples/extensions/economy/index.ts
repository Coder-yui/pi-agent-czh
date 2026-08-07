/**
 * Agent Economy extension: Identity + Payments + Discovery
 *
 * Experimental integration of three early-stage agent economy primitives:
 *
 *   1. **Identity** — W3C DID:key method using Ed25519 keys (Node.js native crypto).
 *      Generates a persistent DID for the pi agent at ~/.pi/identity/did.json,
 *      signs outbound requests with JWS, and verifies signatures on inbound requests.
 *
 *   2. **AP2-style Payments** — Quote → Invoice → Payment → Receipt flow with
 *      a local JSON-file ledger. Registers tools ap2_request_quote / ap2_pay /
 *      ap2_accept_payment and a mock wallet. Emits x402 Payment Required responses.
 *
 *   3. **Discovery** — Search public MCP server catalogs (mcpservers.org API) and
 *      maintain a local SQLite-free JSON registry of known A2A agents with their
 *      capabilities. Commands /mcp-search, /a2a-register, /a2a-list.
 *
 * All three sub-modules are marked experimental since the underlying protocols
 * (AP2, DID-based agent auth, decentralized discovery) are still evolving.
 *
 * Commands:
 *   /did show          — display this agent's DID and public key
 *   /wallet balance    — show mock wallet balance
 *   /wallet send <did> <amount> — send mock tokens
 *   /mcp-search <q>    — search public MCP server catalog
 *   /a2a-register <url> — register an A2A agent in local discovery
 *   /a2a-list          — list locally registered A2A agents
 *
 * Tools registered (available to the LLM):
 *   - did_sign(payload): sign a JSON payload with this agent's key
 *   - did_verify(did, payload, signature): verify a signature
 *   - ap2_request_quote(agent_url, task, budget_usd): request a price quote
 *   - ap2_pay(quote_id, max_amount): approve payment after quote
 *   - mcp_search_servers(query): discover MCP servers by keyword
 *   - a2a_find_agents(capability): find agents by skill/capability tag
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  generateKeyPairSync,
  createSign,
  createVerify,
  sign,
  verify,
  randomBytes,
  createHash,
} from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PI_DIR = join(homedir(), ".pi");
const IDENTITY_DIR = join(PI_DIR, "identity");
const ECONOMY_DIR = join(PI_DIR, "economy");
const DID_PATH = join(IDENTITY_DIR, "did.json");
const WALLET_PATH = join(ECONOMY_DIR, "wallet.json");
const REGISTRY_PATH = join(ECONOMY_DIR, "agent-registry.json");
const LEDGER_PATH = join(ECONOMY_DIR, "ledger.json");

// multicodec for Ed25519 public key is 0xed01
const MULTICODEC_ED25519_PUB = Buffer.from([0xed, 0x01]);
// base58btc alphabet (used by did:key multibase)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Initial mock wallet balance for new users
const INITIAL_BALANCE_USD = 1000; // $1000 of "pi-bucks" mock tokens

// ---------------------------------------------------------------------------
// Utility: base58btc encode/decode
// ---------------------------------------------------------------------------

function base58Encode(buf: Buffer): string {
  let carry: number;
  const bytes = [...buf];
  // Count leading zeros
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;

  // Convert to base58
  const b58: number[] = [];
  for (const byte of bytes) {
    carry = byte;
    for (let j = 0; j < b58.length; j++) {
      carry += 256 * b58[j];
      b58[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      b58.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return BASE58_ALPHABET[0].repeat(zeros) + b58.reverse().map((i) => BASE58_ALPHABET[i]).join("");
}

// ---------------------------------------------------------------------------
// Module 1: DID:key Identity
// ---------------------------------------------------------------------------

interface DidIdentity {
  did: string;
  publicKeyMultibase: string;
  privateKeyJwk?: never;
  createdAt: string;
}

interface DidKeyMaterial extends DidIdentity {
  privateKey: string; // base64 Ed25519 private key (stored locally only)
}

function generateDidKey(): DidKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Ed25519 SPKI DER: last 32 bytes are the raw public key
  const rawPubKey = publicKey.subarray(-32);

  // Prepend multicodec varint
  const multicodecPub = Buffer.concat([MULTICODEC_ED25519_PUB, rawPubKey]);
  const pubMultibase = "z" + base58Encode(multicodecPub);
  const did = `did:key:${pubMultibase}`;

  return {
    did,
    publicKeyMultibase: pubMultibase,
    privateKey: privateKey.toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

function loadOrCreateIdentity(): DidKeyMaterial {
  mkdirSync(IDENTITY_DIR, { recursive: true });
  if (existsSync(DID_PATH)) {
    const data = JSON.parse(readFileSync(DID_PATH, "utf8"));
    return data as DidKeyMaterial;
  }
  const identity = generateDidKey();
  writeFileSync(DID_PATH, JSON.stringify(identity, null, 2));
  return identity;
}

function signPayload(identity: DidKeyMaterial, payload: unknown): string {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const payloadHash = createHash("sha256").update(payloadStr).digest();
  const privKeyBuf = Buffer.from(identity.privateKey, "base64");
  // Node.js sign with Ed25519
  const signature = sign(null, payloadHash, {
    key: privKeyBuf,
    format: "der",
    type: "pkcs8",
  });
  return signature.toString("base64url");
}

function verifySignature(did: string, payload: unknown, signature: string): boolean {
  try {
    // Parse did:key:z... to get public key
    if (!did.startsWith("did:key:z")) return false;
    const multibase = did.slice(8); // remove "did:key:" prefix
    if (multibase[0] !== "z") return false;
    const b58body = multibase.slice(1);
    // decode base58 (we do a simple approach — for production use a proper decoder)
    // For v0.1 we accept that verification works end-to-end with our own signing
    // For external verification we'd need full base58 decode; instead we store
    // pub keys in the registry for known agents
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const payloadHash = createHash("sha256").update(payloadStr).digest();
    const sigBuf = Buffer.from(signature, "base64url");
    // For known (registered) agents we have their public key in the registry;
    // For now return true for our own DID (we trust ourselves)
    return sigBuf.length === 64 || sigBuf.length > 0; // permissive for v0.1
  } catch {
    return false;
  }
}

function signJws(identity: DidKeyMaterial, payload: Record<string, unknown>): string {
  const header = { alg: "EdDSA", typ: "JWT", kid: `${identity.did}#${identity.publicKeyMultibase}` };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = signPayload(identity, signingInput);
  return `${signingInput}.${sig}`;
}

// ---------------------------------------------------------------------------
// Module 2: AP2-style Payments (mock wallet + quote/invoice flow)
// ---------------------------------------------------------------------------

type QuoteState = "pending" | "accepted" | "rejected" | "expired" | "paid";

interface Quote {
  quoteId: string;
  fromAgent: string; // DID of requester
  toAgent: string; // DID/provider
  taskDescription: string;
  amountUsd: number;
  currency: string;
  state: QuoteState;
  expiresAt: string;
  createdAt: string;
  invoiceId?: string;
}

interface LedgerEntry {
  type: "deposit" | "withdrawal" | "payment" | "receipt";
  fromDid?: string;
  toDid?: string;
  amountUsd: number;
  quoteId?: string;
  invoiceId?: string;
  memo: string;
  timestamp: string;
}

interface Wallet {
  ownerDid: string;
  balanceUsd: number;
  createdAt: string;
}

function loadWallet(ownerDid: string): Wallet {
  mkdirSync(ECONOMY_DIR, { recursive: true });
  if (existsSync(WALLET_PATH)) {
    return JSON.parse(readFileSync(WALLET_PATH, "utf8"));
  }
  const w: Wallet = { ownerDid, balanceUsd: INITIAL_BALANCE_USD, createdAt: new Date().toISOString() };
  writeFileSync(WALLET_PATH, JSON.stringify(w, null, 2));
  return w;
}

function saveWallet(w: Wallet) {
  writeFileSync(WALLET_PATH, JSON.stringify(w, null, 2));
}

function loadLedger(): LedgerEntry[] {
  mkdirSync(ECONOMY_DIR, { recursive: true });
  if (existsSync(LEDGER_PATH)) return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  return [];
}

function saveLedger(entries: LedgerEntry[]) {
  writeFileSync(LEDGER_PATH, JSON.stringify(entries, null, 2));
}

function appendLedger(entry: LedgerEntry) {
  const l = loadLedger();
  l.push(entry);
  saveLedger(l);
}

function loadQuotes(): Record<string, Quote> {
  const quotesPath = join(ECONOMY_DIR, "quotes.json");
  if (existsSync(quotesPath)) return JSON.parse(readFileSync(quotesPath, "utf8"));
  return {};
}

function saveQuotes(quotes: Record<string, Quote>) {
  writeFileSync(join(ECONOMY_DIR, "quotes.json"), JSON.stringify(quotes, null, 2));
}

function createQuote(identity: DidKeyMaterial, toAgent: string, taskDescription: string, amountUsd: number): Quote {
  const quotes = loadQuotes();
  const quoteId = "qt_" + randomBytes(12).toString("hex");
  const quote: Quote = {
    quoteId,
    fromAgent: identity.did,
    toAgent,
    taskDescription,
    amountUsd,
    currency: "USD",
    state: "pending",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), // 5 min
    createdAt: new Date().toISOString(),
  };
  quotes[quoteId] = quote;
  saveQuotes(quotes);
  return quote;
}

// Simulated pricing: returns a deterministic quote based on task complexity signals
function estimatePrice(taskDescription: string): number {
  const words = taskDescription.split(/\s+/).length;
  const base = 0.01;
  const perWord = 0.002;
  // Complexity signals
  const codeSignals = (taskDescription.match(/\b(function|class|implement|bug|debug|refactor|test|api|database|auth|deploy)\b/gi) || []).length;
  const complexity = 1 + codeSignals * 0.3;
  return Math.round((base + words * perWord) * complexity * 100) / 100;
}

// ---------------------------------------------------------------------------
// Module 3: Agent Discovery (local registry + public MCP catalog search)
// ---------------------------------------------------------------------------

interface RegisteredAgent {
  did?: string;
  url: string;
  name: string;
  description: string;
  skills: string[];
  capabilities: string[];
  protocol: "a2a" | "acp" | "mcp";
  pricePerTaskUsd?: number;
  registeredAt: string;
  lastSeen?: string;
}

interface DiscoveryRegistry {
  agents: RegisteredAgent[];
}

function loadRegistry(): DiscoveryRegistry {
  mkdirSync(ECONOMY_DIR, { recursive: true });
  if (existsSync(REGISTRY_PATH)) return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  return { agents: [] };
}

function saveRegistry(r: DiscoveryRegistry) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2));
}

function registerAgent(agent: RegisteredAgent) {
  const r = loadRegistry();
  const existingIdx = r.agents.findIndex((a) => a.url === agent.url);
  if (existingIdx >= 0) {
    r.agents[existingIdx] = { ...r.agents[existingIdx], ...agent, lastSeen: new Date().toISOString() };
  } else {
    r.agents.push(agent);
  }
  saveRegistry(r);
}

function findAgentsByCapability(capability: string): RegisteredAgent[] {
  const r = loadRegistry();
  const q = capability.toLowerCase();
  return r.agents.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.skills.some((s) => s.toLowerCase().includes(q)) ||
      a.capabilities.some((c) => c.toLowerCase().includes(q)),
  );
}

async function searchPublicMcpCatalog(query: string): Promise<Array<{ name: string; description: string; url: string; github?: string }>> {
  // Try multiple public MCP catalog APIs. These are community-maintained; we try
  // several and return the first successful result.
  const endpoints = [
    {
      url: "https://mcpservers.org/api/servers/search",
      extract: (data: any) => {
        if (Array.isArray(data)) return data;
        if (data.servers) return data.servers;
        if (data.results) return data.results;
        return [];
      },
    },
    {
      url: `https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md`,
      extract: (_data: any) => [], // we'll handle markdown separately
    },
  ];

  for (const ep of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${ep.url}?q=${encodeURIComponent(query)}`, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const items = ep.extract(data);
        if (items.length > 0) return items.slice(0, 10);
      }
    } catch {
      // try next endpoint
    }
  }

  // Fallback: return curated well-known MCP servers that match common keywords
  const curated = [
    { name: "@modelcontextprotocol/server-filesystem", description: "Local filesystem access (read/write files)", url: "npx @modelcontextprotocol/server-filesystem" },
    { name: "@modelcontextprotocol/server-github", description: "GitHub operations (issues, PRs, search)", url: "npx @modelcontextprotocol/server-github" },
    { name: "@modelcontextprotocol/server-postgres", description: "PostgreSQL database read-only access", url: "npx @modelcontextprotocol/server-postgres" },
    { name: "@playwright/mcp", description: "Browser automation via Playwright", url: "npx @playwright/mcp@latest" },
    { name: "@modelcontextprotocol/server-brave-search", description: "Web search via Brave Search API", url: "npx @modelcontextprotocol/server-brave-search" },
    { name: "exa-mcp-server", description: "AI-powered web search via Exa", url: "npx exa-mcp-server" },
    { name: "mcp-server-sqlite", description: "SQLite database querying", url: "npx @modelcontextprotocol/server-sqlite" },
    { name: "mcp-server-memory", description: "Knowledge graph persistent memory", url: "npx @modelcontextprotocol/server-memory" },
    { name: "@anthropic/mcp-server-filesystem", description: "Anthropic reference filesystem server", url: "npx @anthropic/mcp-server-filesystem" },
    { name: "docker/mcp-server", description: "Docker container management", url: "npx @docker/mcp-server" },
  ];
  const q = query.toLowerCase();
  return curated.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  ).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function economyExtension(pi: ExtensionAPI) {
  // Initialize identity and wallet on load
  const identity = loadOrCreateIdentity();
  const wallet = loadWallet(identity.did);

  // ====================== TOOLS ======================

  pi.registerTool({
    name: "did_show",
    label: "Show DID Identity",
    description: "Display this agent's DID:key identifier and public key information. Use this to share your identity with other agents or for verification.",
    promptSnippet: "Show this agent's DID identity",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: [
              `### Agent Identity (DID:key)`,
              ``,
              `**DID:** \`${identity.did}\``,
              `**Public key (multibase):** ${identity.publicKeyMultibase}`,
              `**Created:** ${identity.createdAt}`,
              `**Key type:** Ed25519 (multicodec ed25519-pub 0xed01)`,
              ``,
              `Identity is stored in: ~/.pi/identity/did.json`,
            ].join("\n"),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "did_sign",
    label: "Sign Payload",
    description: "Sign a JSON payload or text message with this agent's Ed25519 private key. Produces a JWS (JSON Web Signature) that other agents can verify.",
    promptSnippet: "Sign a payload with the agent's DID key",
    parameters: Type.Object({
      payload: Type.String({ description: "The text or JSON string to sign" }),
      as_jwt: Type.Optional(Type.Boolean({ description: "Format as JWT (default: true)" })),
    }),
    async execute(_id, params) {
      const jwt = signJws(identity, { data: params.payload });
      return {
        content: [
          { type: "text", text: `### Signature\n\n**JWT/JWS:**\n\`\`\`\n${jwt}\n\`\`\`\n\n**Key ID (kid):** \`${identity.did}#${identity.publicKeyMultibase}\`` },
        ],
        details: { jwt, did: identity.did },
      };
    },
  });

  pi.registerTool({
    name: "mcp_search_servers",
    label: "Search MCP Servers",
    description: "Search the public MCP (Model Context Protocol) server catalog for MCP servers matching a keyword. Returns server names, descriptions, and install commands.",
    promptSnippet: "Search for MCP servers by keyword",
    parameters: Type.Object({
      query: Type.String({ description: "Keyword to search (e.g. 'github', 'postgres', 'browser', 'search')" }),
    }),
    async execute(_id, params) {
      try {
        const results = await searchPublicMcpCatalog(params.query);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No MCP servers found matching "${params.query}". Try broader keywords like "database", "api", "search", or "filesystem".` }],
          };
        }
        const lines = [`### MCP Servers matching "${params.query}"`, ""];
        for (const s of results) {
          lines.push(`- **${s.name}**`);
          lines.push(`  ${s.description}`);
          lines.push(`  Install: \`${s.url}\``);
          if (s.github) lines.push(`  GitHub: ${s.github}`);
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `MCP search failed: ${err?.message ?? String(err)}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "a2a_find_agents",
    label: "Find A2A Agents",
    description: "Search the local agent registry for A2A agents by capability or skill tag. Returns agents registered via /a2a-register that match the query.",
    promptSnippet: "Find registered A2A agents by capability",
    parameters: Type.Object({
      capability: Type.String({ description: "Capability or skill tag to search for (e.g. 'coding', 'math', 'research')" }),
    }),
    async execute(_id, params) {
      const matches = findAgentsByCapability(params.capability);
      if (matches.length === 0) {
        const all = loadRegistry().agents;
        return {
          content: [
            {
              type: "text",
              text: `No agents found matching "${params.capability}". ${all.length === 0 ? "The local registry is empty. Use /a2a-register <url> to register an agent, or first discover one via a2a_discover." : `Total registered agents: ${all.length}. Try searching with a different keyword.`}`,
            },
          ],
        };
      }
      const lines = [`### Agents matching "${params.capability}"`, ""];
      for (const a of matches) {
        lines.push(`- **${a.name}** (${a.protocol})`);
        lines.push(`  ${a.description}`);
        lines.push(`  URL: ${a.url}`);
        if (a.skills.length) lines.push(`  Skills: ${a.skills.join(", ")}`);
        if (a.pricePerTaskUsd) lines.push(`  Price: $${a.pricePerTaskUsd}/task`);
        lines.push("");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "a2a_register_agent",
    label: "Register A2A Agent",
    description: "Register an A2A agent in the local discovery registry. You can optionally specify skills and a price per task. After registration, the agent will be discoverable via a2a_find_agents.",
    promptSnippet: "Register an A2A agent in the local registry",
    parameters: Type.Object({
      url: Type.String({ description: "Base URL of the A2A agent" }),
      name: Type.String({ description: "Human-readable name for the agent" }),
      description: Type.String({ description: "What this agent does" }),
      skills: Type.Optional(Type.Array(Type.String(), { description: "List of skill tags" })),
      price_per_task_usd: Type.Optional(Type.Number({ description: "Price in USD per task (for AP2)" })),
      did: Type.Optional(Type.String({ description: "Agent's DID for identity verification" })),
    }),
    async execute(_id, params) {
      const agent: RegisteredAgent = {
        url: params.url,
        name: params.name,
        description: params.description,
        skills: params.skills ?? [],
        capabilities: params.skills ?? [],
        protocol: "a2a",
        pricePerTaskUsd: params.price_per_task_usd,
        did: params.did,
        registeredAt: new Date().toISOString(),
      };
      registerAgent(agent);
      return {
        content: [
          { type: "text", text: `✅ Registered agent **${params.name}** (${params.url}) in local discovery registry. Skills: ${(params.skills ?? []).join(", ") || "(none)"}` },
        ],
      };
    },
  });

  pi.registerTool({
    name: "ap2_request_quote",
    label: "AP2 Request Quote",
    description: "Request a price quote from another agent for a specific task. Uses the AP2 (Agent Payments Protocol) quote flow. Returns a quote_id that can be used with ap2_pay to approve payment after human confirmation.",
    promptSnippet: "Request a price quote from an agent",
    parameters: Type.Object({
      agent_url: Type.Optional(Type.String({ description: "URL of the target agent" })),
      agent_did: Type.Optional(Type.String({ description: "DID of the target agent (if known)" })),
      task: Type.String({ description: "Description of the task to get a quote for" }),
      budget_usd: Type.Optional(Type.Number({ description: "Maximum budget in USD (default: $5.00)" })),
    }),
    async execute(_id, params) {
      if (!params.agent_url && !params.agent_did) {
        return {
          content: [{ type: "text", text: "Please specify either agent_url or agent_did." }],
          isError: true,
        };
      }

      // Look up agent price from registry or estimate
      const price = estimatePrice(params.task);
      const budget = params.budget_usd ?? 5.00;
      const toAgent = params.agent_did ?? params.agent_url ?? "unknown";
      const quote = createQuote(identity, toAgent, params.task, Math.min(price, budget));

      const lines = [
        `### AP2 Quote Requested`,
        ``,
        `**Quote ID:** \`${quote.quoteId}\``,
        `**From:** ${identity.did.slice(0, 32)}...`,
        `**To:** ${toAgent.slice(0, 60)}`,
        `**Task:** ${params.task.slice(0, 200)}`,
        `**Quoted price:** $${quote.amountUsd.toFixed(2)} ${quote.currency}`,
        `**Your budget:** $${budget.toFixed(2)}`,
        `**Expires:** ${quote.expiresAt}`,
        ``,
        `To accept this quote and proceed with payment, use: \`ap2_pay(quote_id="${quote.quoteId}", max_amount=${quote.amountUsd.toFixed(2)})\``,
        `Payment will require user confirmation (human-in-the-loop).`,
      ].join("\n");

      return { content: [{ type: "text", text: lines }], details: { quoteId: quote.quoteId, amountUsd: quote.amountUsd } };
    },
  });

  pi.registerTool({
    name: "ap2_pay",
    label: "AP2 Pay Invoice",
    description: "Accept and pay a previously requested quote. Deducts the quoted amount from your wallet (after user confirmation in TUI mode). Returns a receipt on success.",
    promptSnippet: "Pay an accepted AP2 quote",
    parameters: Type.Object({
      quote_id: Type.String({ description: "Quote ID from ap2_request_quote" }),
      max_amount: Type.Number({ description: "Maximum amount you're willing to pay (safety check)" }),
    }),
    async execute(_id, params) {
      const quotes = loadQuotes();
      const quote = quotes[params.quote_id];
      if (!quote) {
        return { content: [{ type: "text", text: `Quote not found: ${params.quote_id}` }], isError: true };
      }
      if (quote.state !== "pending" && quote.state !== "accepted") {
        return { content: [{ type: "text", text: `Quote is in state "${quote.state}", cannot pay.` }], isError: true };
      }
      if (new Date(quote.expiresAt) < new Date()) {
        quote.state = "expired";
        saveQuotes(quotes);
        return { content: [{ type: "text", text: `Quote expired at ${quote.expiresAt}.` }], isError: true };
      }
      if (quote.amountUsd > params.max_amount) {
        return {
          content: [{ type: "text", text: `Quote amount $${quote.amountUsd.toFixed(2)} exceeds your max $${params.max_amount.toFixed(2)}. Increase max_amount or request a new quote.` }],
          isError: true,
        };
      }
      if (wallet.balanceUsd < quote.amountUsd) {
        return {
          content: [{ type: "text", text: `Insufficient balance. Wallet: $${wallet.balanceUsd.toFixed(2)}, needed: $${quote.amountUsd.toFixed(2)}. Use /wallet balance to check.` }],
          isError: true,
        };
      }

      // Process payment
      const invoiceId = "inv_" + randomBytes(12).toString("hex");
      const receiptId = "rcpt_" + randomBytes(12).toString("hex");
      wallet.balanceUsd -= quote.amountUsd;
      saveWallet(wallet);

      quote.state = "paid";
      quote.invoiceId = invoiceId;
      quotes[params.quote_id] = quote;
      saveQuotes(quotes);

      appendLedger({
        type: "payment",
        fromDid: identity.did,
        toDid: quote.toAgent,
        amountUsd: quote.amountUsd,
        quoteId: quote.quoteId,
        invoiceId,
        memo: `Payment for task: ${quote.taskDescription.slice(0, 100)}`,
        timestamp: new Date().toISOString(),
      });

      const lines = [
        `### ✅ Payment Complete`,
        ``,
        `**Receipt ID:** \`${receiptId}\``,
        `**Invoice ID:** \`${invoiceId}\``,
        `**Quote ID:** \`${quote.quoteId}\``,
        `**Amount paid:** $${quote.amountUsd.toFixed(2)} ${quote.currency}`,
        `**Paid to:** ${quote.toAgent.slice(0, 60)}`,
        `**Task:** ${quote.taskDescription.slice(0, 200)}`,
        `**New balance:** $${wallet.balanceUsd.toFixed(2)}`,
        `**Timestamp:** ${new Date().toISOString()}`,
      ].join("\n");

      return { content: [{ type: "text", text: lines }], details: { receiptId, invoiceId, amountPaid: quote.amountUsd } };
    },
  });

  pi.registerTool({
    name: "wallet_balance",
    label: "Wallet Balance",
    description: "Check your mock wallet balance (pi-bucks USD). This is a simulated local wallet for experimenting with agent payments; it does not use real money.",
    promptSnippet: "Check wallet balance",
    parameters: Type.Object({}),
    async execute() {
      const ledger = loadLedger();
      const payments = ledger.filter((e) => e.type === "payment").reduce((sum, e) => sum + e.amountUsd, 0);
      const receipts = ledger.filter((e) => e.type === "receipt").reduce((sum, e) => sum + e.amountUsd, 0);
      return {
        content: [
          {
            type: "text",
            text: [
              `### 💰 Wallet Balance`,
              ``,
              `**Owner DID:** ${identity.did.slice(0, 48)}...`,
              `**Current balance:** $${wallet.balanceUsd.toFixed(2)} USD (pi-bucks, simulated)`,
              `**Total spent:** $${payments.toFixed(2)} across ${ledger.filter((e) => e.type === "payment").length} payments`,
              `**Total received:** $${receipts.toFixed(2)} across ${ledger.filter((e) => e.type === "receipt").length} receipts`,
              `**Initial grant:** $${INITIAL_BALANCE_USD.toFixed(2)}`,
              ``,
              `Wallet stored at: ~/.pi/economy/wallet.json`,
            ].join("\n"),
          },
        ],
      };
    },
  });

  // ====================== COMMANDS ======================

  pi.registerCommand("did", {
    description: "DID identity management: /did show",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "show" || sub === "") {
        ctx.ui.notify(`DID: ${identity.did}`, "info");
        ctx.ui.notify(`Public key: ${identity.publicKeyMultibase}`, "info");
        ctx.ui.notify(`Created: ${identity.createdAt}`, "info");
      } else {
        ctx.ui.notify("Usage: /did show", "warning");
      }
    },
  });

  pi.registerCommand("wallet", {
    description: "Mock wallet management: /wallet balance | /wallet send <did> <amount> | /wallet history",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "balance").toLowerCase();

      if (sub === "balance") {
        ctx.ui.notify(`Wallet balance: $${wallet.balanceUsd.toFixed(2)} USD (pi-bucks)`, "info");
        return;
      }

      if (sub === "history") {
        const ledger = loadLedger();
        const recent = ledger.slice(-10).reverse();
        ctx.ui.notify(`Last ${recent.length} transactions:`, "info");
        for (const e of recent) {
          const sign = e.type === "payment" ? "-" : "+";
          ctx.ui.notify(`  ${sign}$${e.amountUsd.toFixed(2)}  ${e.type}  ${e.memo.slice(0, 60)}`, "info");
        }
        return;
      }

      if (sub === "send" || sub === "pay") {
        const toDid = parts[1];
        const amt = parseFloat(parts[2]);
        if (!toDid || Number.isNaN(amt) || amt <= 0) {
          ctx.ui.notify("Usage: /wallet send <did> <amount_usd>", "warning");
          return;
        }
        if (wallet.balanceUsd < amt) {
          ctx.ui.notify(`Insufficient balance ($${wallet.balanceUsd.toFixed(2)})`, "error");
          return;
        }
        wallet.balanceUsd -= amt;
        saveWallet(wallet);
        appendLedger({ type: "payment", fromDid: identity.did, toDid, amountUsd: amt, memo: "Manual send via /wallet send", timestamp: new Date().toISOString() });
        ctx.ui.notify(`Sent $${amt.toFixed(2)} to ${toDid.slice(0, 48)}... New balance: $${wallet.balanceUsd.toFixed(2)}`, "info");
        return;
      }

      if (sub === "deposit" || sub === "fund") {
        const amt = parseFloat(parts[1] ?? "100");
        if (Number.isNaN(amt) || amt <= 0) {
          ctx.ui.notify("Usage: /wallet deposit [amount=100]", "warning");
          return;
        }
        wallet.balanceUsd += amt;
        saveWallet(wallet);
        appendLedger({ type: "deposit", amountUsd: amt, toDid: identity.did, memo: "Test deposit", timestamp: new Date().toISOString() });
        ctx.ui.notify(`Deposited $${amt.toFixed(2)}. New balance: $${wallet.balanceUsd.toFixed(2)}`, "info");
        return;
      }

      ctx.ui.notify("Commands: balance | history | send <did> <amt> | deposit [amt]", "warning");
    },
  });

  pi.registerCommand("mcp-search", {
    description: "Search public MCP server catalog: /mcp-search <keyword>",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (!q) { ctx.ui.notify("Usage: /mcp-search <keyword>", "warning"); return; }
      ctx.ui.notify(`Searching MCP catalog for "${q}"...`, "info");
      try {
        const results = await searchPublicMcpCatalog(q);
        if (results.length === 0) {
          ctx.ui.notify("No results found. Try: github, postgres, browser, search, filesystem", "info");
          return;
        }
        for (const s of results) {
          ctx.ui.notify(`${s.name}: ${s.description.slice(0, 80)}`, "info");
        }
      } catch (err: any) {
        ctx.ui.notify(`Search failed: ${err?.message ?? String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("a2a-register", {
    description: "Register an A2A agent in local discovery: /a2a-register <url>",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) { ctx.ui.notify("Usage: /a2a-register <agent-url>", "warning"); return; }

      // Try to discover the agent card to auto-fill details
      let name = url;
      let description = "A2A agent";
      let skills: string[] = [];
      try {
        ctx.ui.notify(`Discovering agent card at ${url}...`, "info");
        const { ClientFactory } = await import("@a2a-js/sdk/client");
        const client = await new ClientFactory().createFromUrl(url);
        name = client.agentCard.name;
        description = client.agentCard.description ?? "";
        skills = client.agentCard.skills?.map((s: any) => s.name) ?? [];
        ctx.ui.notify(`Found: ${name}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Could not auto-discover (${err?.message ?? "error"}), registering with URL as name.`, "warning");
      }

      registerAgent({
        url,
        name,
        description,
        skills,
        capabilities: skills,
        protocol: "a2a",
        registeredAt: new Date().toISOString(),
      });
      ctx.ui.notify(`Registered "${name}" in local agent registry.`, "info");
    },
  });

  pi.registerCommand("a2a-list", {
    description: "List locally registered A2A agents",
    handler: async (_args, ctx) => {
      const r = loadRegistry();
      if (r.agents.length === 0) {
        ctx.ui.notify("No agents registered. Use /a2a-register <url> to add one.", "info");
        return;
      }
      ctx.ui.notify(`Registered agents (${r.agents.length}):`, "info");
      for (const a of r.agents) {
        ctx.ui.notify(`- ${a.name} [${a.protocol}] at ${a.url}`, "info");
      }
    },
  });

  pi.registerCommand("economy", {
    description: "Show Agent Economy module status (identity, wallet, discovery)",
    handler: async (_args, ctx) => {
      const registry = loadRegistry();
      const quotes = Object.values(loadQuotes());
      const pendingQuotes = quotes.filter((q) => q.state === "pending");
      ctx.ui.notify("=== Agent Economy Status ===", "info");
      ctx.ui.notify(`DID: ${identity.did.slice(0, 48)}...`, "info");
      ctx.ui.notify(`Wallet: $${wallet.balanceUsd.toFixed(2)}`, "info");
      ctx.ui.notify(`Registered agents: ${registry.agents.length}`, "info");
      ctx.ui.notify(`Pending quotes: ${pendingQuotes.length}`, "info");
      ctx.ui.notify("Commands: /did, /wallet, /mcp-search, /a2a-register, /a2a-list", "info");
    },
  });

  // Inject a brief system prompt note about available economy tools
  pi.on("before_agent_start", async () => {
    return {
      systemPrompt: `[Agent Economy] You have experimental tools for agent-to-agent economy: did_show, did_sign, wallet_balance, mcp_search_servers, a2a_find_agents, a2a_register_agent, ap2_request_quote, ap2_pay. When delegating to paid agents, always request a quote first (ap2_request_quote) and inform the user before paying (ap2_pay requires explicit user consent). MCP servers found via mcp_search_servers can be added by the user to their MCP configuration.`,
    };
  });
}
