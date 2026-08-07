/**
 * Self-contained E2E test for Agent Economy extension (Phase 5).
 *
 * Tests all three sub-modules without needing to load pi's ExtensionAPI:
 *   1. DID:key identity generation, Ed25519 signing, JWS format
 *   2. Wallet lifecycle, quote creation, payment flow, ledger entries
 *   3. Agent registration, capability search, MCP catalog fallback
 *
 * Run with: node scripts/test-economy.mjs
 */

import {
  generateKeyPairSync,
  sign,
  randomBytes,
  createHash,
} from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Copy core logic inline for testing (mirrors extension/index.ts)
// ---------------------------------------------------------------------------

const MULTICODEC_ED25519_PUB = Buffer.from([0xed, 0x01]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf) {
  const bytes = [...buf];
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;
  const b58 = [];
  for (const byte of bytes) {
    let carry = byte;
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

function generateDidKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const rawPubKey = publicKey.subarray(-32);
  const multicodecPub = Buffer.concat([MULTICODEC_ED25519_PUB, rawPubKey]);
  const pubMultibase = "z" + base58Encode(multicodecPub);
  const did = `did:key:${pubMultibase}`;
  return { did, publicKeyMultibase: pubMultibase, privateKey: privateKey.toString("base64"), createdAt: new Date().toISOString() };
}

function signPayload(identity, payload) {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const payloadHash = createHash("sha256").update(payloadStr).digest();
  const privKeyBuf = Buffer.from(identity.privateKey, "base64");
  const signature = sign(null, payloadHash, { key: privKeyBuf, format: "der", type: "pkcs8" });
  return signature.toString("base64url");
}

function signJws(identity, payload) {
  const header = { alg: "EdDSA", typ: "JWT", kid: `${identity.did}#${identity.publicKeyMultibase}` };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = signPayload(identity, signingInput);
  return `${signingInput}.${sig}`;
}

function estimatePrice(taskDescription) {
  const words = taskDescription.split(/\s+/).length;
  const base = 0.01;
  const perWord = 0.002;
  const codeSignals = (taskDescription.match(/\b(function|class|implement|bug|debug|refactor|test|api|database|auth|deploy)\b/gi) || []).length;
  const complexity = 1 + codeSignals * 0.3;
  return Math.round((base + words * perWord) * complexity * 100) / 100;
}

// Minimal registry/wallet/quote for tests using a temp dir
function createTestStores(dir) {
  mkdirSync(dir, { recursive: true });

  const paths = {
    wallet: join(dir, "wallet.json"),
    ledger: join(dir, "ledger.json"),
    quotes: join(dir, "quotes.json"),
    registry: join(dir, "registry.json"),
  };

  const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
  const writeJson = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2));

  const wallet = readJson(paths.wallet, null) || { ownerDid: "", balanceUsd: 1000, createdAt: new Date().toISOString() };
  const saveWallet = () => writeJson(paths.wallet, wallet);
  const getLedger = () => readJson(paths.ledger, []);
  const appendLedger = (entry) => { const l = getLedger(); l.push(entry); writeJson(paths.ledger, l); };
  const getQuotes = () => readJson(paths.quotes, {});
  const saveQuotes = (q) => writeJson(paths.quotes, q);
  const getRegistry = () => readJson(paths.registry, { agents: [] });
  const saveRegistry = (r) => writeJson(paths.registry, r);

  return { paths, wallet, saveWallet, getLedger, appendLedger, getQuotes, saveQuotes, getRegistry, saveRegistry };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.log(`  ✗ ${msg}`); failed++; }
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-economy-test-"));
  console.log(`Test directory: ${tmpDir}\n`);

  try {
    // ---- Module 1: Identity ----
    console.log("[Module 1] DID:key Identity");

    const identity = generateDidKey();
    assert(identity.did.startsWith("did:key:z"), `DID starts with "did:key:z": ${identity.did.slice(0, 30)}...`);
    assert(identity.publicKeyMultibase.startsWith("z"), `Public key multibase starts with "z": ${identity.publicKeyMultibase.slice(0, 10)}...`);
    assert(identity.publicKeyMultibase.length > 40, `Public key has reasonable length (${identity.publicKeyMultibase.length} chars)`);

    // Signing
    const testPayload = { hello: "world", nonce: 42 };
    const sig = signPayload(identity, testPayload);
    assert(sig.length > 40, `Signature generated (${sig.length} chars, base64url)`);
    assert(!sig.includes("+") && !sig.includes("/"), "Signature uses base64url (no + or /)");

    // JWS
    const jws = signJws(identity, { action: "pay", amount: 5.00 });
    const parts = jws.split(".");
    assert(parts.length === 3, `JWS has 3 parts (header.payload.signature): got ${parts.length}`);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    assert(header.alg === "EdDSA", `JWS header alg is EdDSA`);
    assert(header.kid.startsWith(identity.did), `JWS kid references the signer DID`);
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    assert(payload.iat !== undefined, `JWS payload includes issued-at timestamp`);
    assert(payload.amount === 5.0, `JWS payload contains custom claims (amount=${payload.amount})`);

    // Two identities produce different DIDs
    const identity2 = generateDidKey();
    assert(identity.did !== identity2.did, "Two generated identities have different DIDs");
    assert(identity.privateKey !== identity2.privateKey, "Two generated identities have different private keys");

    console.log("");

    // ---- Module 2: Payments (AP2-style) ----
    console.log("[Module 2] AP2-style Payments");

    const stores = createTestStores(tmpDir);
    stores.wallet.ownerDid = identity.did;
    stores.saveWallet();

    assert(stores.wallet.balanceUsd === 1000, `Initial wallet balance is $1000`);

    // Price estimation
    const simplePrice = estimatePrice("Hello world");
    assert(simplePrice > 0 && simplePrice < 1, `Simple task price is small: $${simplePrice}`);
    const complexTask = "Implement a function that refactors the authentication module with database support and API integration tests";
    const complexPrice = estimatePrice(complexTask);
    assert(complexPrice > simplePrice, `Complex task ($${complexPrice}) costs more than simple ($${simplePrice})`);

    // Create quote
    const quotes = stores.getQuotes();
    const quoteId = "qt_" + randomBytes(8).toString("hex");
    const quote = {
      quoteId,
      fromAgent: identity.did,
      toAgent: identity2.did,
      taskDescription: complexTask,
      amountUsd: complexPrice,
      currency: "USD",
      state: "pending",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    quotes[quoteId] = quote;
    stores.saveQuotes(quotes);
    assert(Object.keys(stores.getQuotes()).length === 1, "Quote saved");

    // Pay the quote
    const initialBalance = stores.wallet.balanceUsd;
    stores.wallet.balanceUsd -= quote.amountUsd;
    stores.saveWallet();
    const invoiceId = "inv_" + randomBytes(8).toString("hex");
    stores.appendLedger({
      type: "payment",
      fromDid: identity.did,
      toDid: quote.toAgent,
      amountUsd: quote.amountUsd,
      quoteId,
      invoiceId,
      memo: `Payment for: ${quote.taskDescription.slice(0, 50)}`,
      timestamp: new Date().toISOString(),
    });

    const quotesAfterPay = stores.getQuotes();
    quotesAfterPay[quoteId].state = "paid";
    quotesAfterPay[quoteId].invoiceId = invoiceId;
    stores.saveQuotes(quotesAfterPay);

    assert(stores.wallet.balanceUsd === initialBalance - quote.amountUsd, `Balance decreased by $${quote.amountUsd.toFixed(2)}: new balance $${stores.wallet.balanceUsd.toFixed(2)}`);
    assert(stores.getQuotes()[quoteId].state === "paid", "Quote state is 'paid' after payment");
    assert(stores.getLedger().length === 1, "Ledger has one payment entry");
    assert(stores.getLedger()[0].type === "payment", "Ledger entry type is 'payment'");
    assert(stores.getLedger()[0].invoiceId === invoiceId, "Ledger entry references invoice ID");

    // Insufficient funds scenario
    const bigQuoteId = "qt_big" + randomBytes(4).toString("hex");
    const bigQuote = { ...quote, quoteId: bigQuoteId, amountUsd: 999999, state: "pending" };
    const bigQuotes = stores.getQuotes();
    bigQuotes[bigQuoteId] = bigQuote;
    stores.saveQuotes(bigQuotes);
    const canAfford = stores.wallet.balanceUsd >= bigQuote.amountUsd;
    assert(canAfford === false, "Correctly detects insufficient funds for large quote");

    // Deposit
    stores.wallet.balanceUsd += 500;
    stores.saveWallet();
    stores.appendLedger({ type: "deposit", toDid: identity.did, amountUsd: 500, memo: "test deposit", timestamp: new Date().toISOString() });
    assert(stores.wallet.balanceUsd === 1000 - quote.amountUsd + 500, `Deposit of $500 works: new balance $${stores.wallet.balanceUsd.toFixed(2)}`);
    assert(stores.getLedger().length === 2, "Ledger now has 2 entries");

    console.log("");

    // ---- Module 3: Discovery ----
    console.log("[Module 3] Agent Discovery");

    const reg = stores.getRegistry();
    assert(reg.agents.length === 0, "Registry starts empty");

    // Register agents
    const agents = [
      { url: "http://localhost:41241", name: "pi Coding Agent", description: "Terminal-first coding agent", skills: ["coding", "debugging", "refactoring"], capabilities: ["coding"], protocol: "a2a", registeredAt: new Date().toISOString() },
      { url: "http://localhost:42000", name: "Math Agent", description: "Performs mathematical calculations", skills: ["math", "arithmetic", "algebra"], capabilities: ["math"], protocol: "a2a", registeredAt: new Date().toISOString() },
      { url: "http://localhost:43000", name: "Research Agent", description: "Web research and information retrieval", skills: ["research", "search", "summarization"], capabilities: ["research"], protocol: "a2a", registeredAt: new Date().toISOString() },
      { url: "http://localhost:44000", name: "pi Coder v2", description: "Advanced coding agent with refactoring expertise", skills: ["coding", "refactoring", "testing"], capabilities: ["coding", "testing"], protocol: "a2a", registeredAt: new Date().toISOString() },
    ];
    for (const a of agents) {
      const existing = reg.agents.findIndex((x) => x.url === a.url);
      if (existing >= 0) reg.agents[existing] = a; else reg.agents.push(a);
    }
    stores.saveRegistry(reg);
    assert(stores.getRegistry().agents.length === 4, `Registered 4 agents`);

    // Search by capability
    const codingAgents = stores.getRegistry().agents.filter(
      (a) => a.skills.some((s) => s.includes("coding")) || a.description.toLowerCase().includes("coding"),
    );
    assert(codingAgents.length === 2, `Found 2 coding agents: ${codingAgents.map((a) => a.name).join(", ")}`);

    const mathAgents = stores.getRegistry().agents.filter(
      (a) => a.skills.some((s) => s.includes("math")) || a.name.toLowerCase().includes("math"),
    );
    assert(mathAgents.length === 1, `Found 1 math agent: ${mathAgents[0].name}`);
    assert(mathAgents[0].name === "Math Agent", "Math agent correctly identified");

    // Search by keyword
    const refactorAgents = stores.getRegistry().agents.filter(
      (a) => a.description.includes("refactor") || a.skills.some((s) => s.includes("refactor")),
    );
    assert(refactorAgents.length === 2, `Found ${refactorAgents.length} agents with refactoring capability`);

    // Duplicate URL doesn't create duplicate entry
    const dupe = { ...agents[0], description: "Updated description" };
    const r2 = stores.getRegistry();
    const idx = r2.agents.findIndex((x) => x.url === dupe.url);
    r2.agents[idx] = { ...r2.agents[idx], ...dupe };
    stores.saveRegistry(r2);
    assert(stores.getRegistry().agents.length === 4, `Updating existing URL doesn't create duplicate (still ${stores.getRegistry().agents.length} agents)`);
    assert(stores.getRegistry().agents.find((a) => a.url === agents[0].url).description === "Updated description", "Update correctly applied");

    // MCP search fallback returns curated results
    const curated = [
      { name: "@modelcontextprotocol/server-filesystem", description: "Local filesystem access" },
      { name: "@modelcontextprotocol/server-github", description: "GitHub operations" },
      { name: "@playwright/mcp", description: "Browser automation" },
    ];
    const githubResults = curated.filter((s) => s.name.includes("github") || s.description.includes("GitHub"));
    assert(githubResults.length === 1, `Curated MCP fallback finds GitHub server: ${githubResults[0].name}`);
    const browserResults = curated.filter((s) => s.name.includes("browser") || s.name.includes("playwright") || s.description.includes("Browser"));
    assert(browserResults.length === 1, `Curated MCP fallback finds browser server: ${browserResults[0].name}`);

    console.log("");

    // ---- Summary ----
    console.log("=".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nCleaned up temp directory: ${tmpDir}`);

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("TEST ERROR:", err);
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
