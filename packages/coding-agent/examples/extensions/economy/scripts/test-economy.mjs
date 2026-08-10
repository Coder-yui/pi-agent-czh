/** End-to-end test for the real Agent Economy extension. */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactVerify } from "jose";
import { base58btc } from "multiformats/bases/base58";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-economy-test-"));
process.env.PI_AGENT_ECONOMY_HOME = tempRoot;
const { default: economyExtension } = await import("../index.ts");

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  on(event, handler) {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  },
};

economyExtension(pi);

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`  ✓ ${message}`);
}

let confirmPayment = false;
const context = {
  hasUI: true,
  ui: {
    async confirm() { return confirmPayment; },
    notify() {},
  },
};

try {
  assert(tools.has("did_sign") && tools.has("did_verify"), "real extension registered DID signing and verification tools");
  assert(tools.has("ap2_request_quote") && tools.has("ap2_pay"), "real extension registered simulated payment tools");

  const identityPath = join(tempRoot, "identity", "did.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8"));
  assert(identity.did.startsWith("did:key:z"), "identity uses did:key multibase encoding");
  assert((statSync(identityPath).mode & 0o777) === 0o600, "private key file permissions are 0600");

  const signed = await tools.get("did_sign").execute("sign", { payload: "hello", as_jwt: false });
  const verified = await tools.get("did_verify").execute("verify", {
    did: signed.details.did,
    payload: "hello",
    signature: signed.details.signature,
  });
  assert(verified.details.valid === true, "valid Ed25519 signature verifies against did:key");
  const tampered = await tools.get("did_verify").execute("verify", {
    did: signed.details.did,
    payload: "tampered",
    signature: signed.details.signature,
  });
  assert(tampered.details.valid === false, "tampered payload fails cryptographic verification");

  const jws = await tools.get("did_sign").execute("sign-jws", { payload: "hello", as_jwt: true });
  const publicKeyBytes = Buffer.from(base58btc.decode(identity.publicKeyMultibase)).subarray(2);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKeyBytes]),
    format: "der",
    type: "spki",
  });
  const standardVerification = await compactVerify(jws.details.jwt, publicKey);
  assert(standardVerification.protectedHeader.alg === "EdDSA", "compact JWS verifies with the standard jose implementation");
  const jwsVerified = await tools.get("did_verify").execute("verify-jws", {
    did: identity.did,
    jws: jws.details.jwt,
  });
  assert(jwsVerified.details.valid === true, "did_verify accepts a standard compact JWS");

  const overBudget = await tools.get("ap2_request_quote").execute("over-budget", {
    agent_did: "did:key:zRemote",
    task: "Implement debug refactor test api database auth deploy function class parser with extensive coverage",
    budget_usd: 0.01,
  });
  assert(overBudget.isError === true, "a quote above the requested budget is rejected instead of silently discounted");

  const quote = await tools.get("ap2_request_quote").execute("quote", {
    agent_did: "did:key:zRemote",
    task: "Implement and test a parser",
    budget_usd: 5,
  });
  assert(quote.details.quoteId.startsWith("qt_"), "quote is created by the real extension");

  const before = JSON.parse(readFileSync(join(tempRoot, "economy", "wallet.json"), "utf8")).balanceUsd;
  const cancelled = await tools.get("ap2_pay").execute(
    "pay",
    { quote_id: quote.details.quoteId, max_amount: quote.details.amountUsd },
    undefined,
    undefined,
    context,
  );
  assert(cancelled.isError === true, "payment is blocked when the user declines confirmation");
  const afterCancel = JSON.parse(readFileSync(join(tempRoot, "economy", "wallet.json"), "utf8")).balanceUsd;
  assert(afterCancel === before, "declined payment does not mutate the wallet");

  confirmPayment = true;
  const paid = await tools.get("ap2_pay").execute(
    "pay",
    { quote_id: quote.details.quoteId, max_amount: quote.details.amountUsd },
    undefined,
    undefined,
    context,
  );
  assert(paid.details.receiptId.startsWith("rcpt_"), "confirmed payment produces a receipt");
  const afterPay = JSON.parse(readFileSync(join(tempRoot, "economy", "wallet.json"), "utf8")).balanceUsd;
  assert(afterPay === before - quote.details.amountUsd, "confirmed payment deducts exactly the quoted amount");

  const concurrentQuote = await tools.get("ap2_request_quote").execute("concurrent-quote", {
    agent_did: "did:key:zRemote",
    task: "Test a parser",
    budget_usd: 5,
  });
  const concurrentBefore = JSON.parse(readFileSync(join(tempRoot, "economy", "wallet.json"), "utf8")).balanceUsd;
  const concurrentPayments = await Promise.all([
    tools.get("ap2_pay").execute(
      "pay-a",
      { quote_id: concurrentQuote.details.quoteId, max_amount: concurrentQuote.details.amountUsd },
      undefined,
      undefined,
      context,
    ),
    tools.get("ap2_pay").execute(
      "pay-b",
      { quote_id: concurrentQuote.details.quoteId, max_amount: concurrentQuote.details.amountUsd },
      undefined,
      undefined,
      context,
    ),
  ]);
  assert(concurrentPayments.filter((result) => !result.isError).length === 1, "concurrent payment attempts produce exactly one receipt");
  const concurrentAfter = JSON.parse(readFileSync(join(tempRoot, "economy", "wallet.json"), "utf8")).balanceUsd;
  assert(
    concurrentAfter === concurrentBefore - concurrentQuote.details.amountUsd,
    "concurrent payment attempts deduct the quoted amount only once",
  );

  await tools.get("a2a_register_agent").execute("register", {
    url: "http://127.0.0.1:41241",
    name: "Test Coder",
    description: "Coding and testing agent",
    skills: ["coding", "testing"],
  });
  const found = await tools.get("a2a_find_agents").execute("find", { capability: "coding" });
  assert(found.content[0].text.includes("Test Coder"), "registered agent is discoverable by capability");

  console.log(`\nResults: ${passed} passed, 0 failed`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
