# Phase 5: Agent Economy — Identity + Payments + Discovery (Experimental)

> **Implementation date:** 2026-08-07
> **Status:** ✅ Complete (v0.1, experimental)
> **Location:** `packages/coding-agent/examples/extensions/economy/`
> **Maturity note:** The underlying protocols (DID-based agent auth, AP2 payments, decentralized discovery) are early-stage and evolving. This is an experimental integration marked as such for the resume.

## Overview

Phase 5 implements the **Agent Economy** layer — three experimental primitives that enable pi to participate in an ecosystem of interoperable, economically-aware AI agents:

1. **Agent Identity (DID:key)** — W3C-compliant decentralized identifier using Ed25519 keys, enabling verifiable agent identity and signed requests.
2. **AP2-style Payments** — A quote → invoice → payment → receipt flow following the Google Agentic Commerce AP2 protocol pattern, with a local mock wallet and ledger (human-in-the-loop approval before any payment).
3. **Agent Discovery** — Public MCP server catalog search + a local JSON-based registry for tracking known A2A agents and their capabilities/price points.

Ed25519 key generation/raw signing uses Node.js crypto, standards encoding uses `multiformats`, compact JWS uses `jose`, and agent-card discovery uses the official A2A SDK. The payment component is explicitly a local AP2-inspired simulator because the official AP2 project currently publishes reference schemas/implementations rather than a mature TypeScript payment SDK.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       pi Agent Session                          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Agent Economy Extension                     │    │
│  │                                                          │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │    │
│  │  │  Identity    │  │  Payments    │  │  Discovery    │  │    │
│  │  │  (DID:key)   │  │  (AP2-style) │  │  (Registry)   │  │    │
│  │  │              │  │              │  │               │  │    │
│  │  │ • DID gen    │  │ • Wallet     │  │ • MCP search  │  │    │
│  │  │ • Ed25519    │  │ • Quotes     │  │ • A2A registry│  │    │
│  │  │ • JWS sign   │  │ • Invoices   │  │ • Capability  │  │    │
│  │  │ • Verify     │  │ • Ledger     │  │   search      │  │    │
│  │  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │    │
│  │         │                 │                   │          │    │
│  │         └────────┬────────┴─────────┬─────────┘          │    │
│  │                  │                  │                    │    │
│  │           ~/.pi/identity/    ~/.pi/economy/              │    │
│  │           did.json           wallet.json                 │    │
│  │                            ledger.json                   │    │
│  │                            quotes.json                   │    │
│  │                            agent-registry.json           │    │
│  └──────────────────┬───────────────────────────────────────┘    │
│                     │                                            │
│            System prompt injection                             │
│                     │                                            │
│            LLM can call: did_show, did_sign, wallet_balance,    │
│              mcp_search_servers, a2a_find_agents,               │
│              a2a_register_agent, ap2_request_quote, ap2_pay     │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### Module 1: Agent Identity (W3C DID:key)

**Standard:** [W3C Decentralized Identifiers (DIDs) v1.0](https://www.w3.org/TR/did-core/), `did:key` method (the simplest self-sovereign DID method, no blockchain required).

**Implementation:**
- Generates an Ed25519 keypair using Node.js native `crypto.generateKeyPairSync('ed25519')`
- Public key is encoded using multicodec (`0xed01` for Ed25519) + `multiformats` base58btc multibase (`z` prefix) to produce the DID: `did:key:z6Mk...`
- Private key is stored only in `~/.pi/identity/did.json`; the directory is mode `0700` and the key file is mode `0600`
- Signs/verifies standard compact JWS using `jose` with the EdDSA algorithm; raw Ed25519 mode signs the payload bytes directly
- Verifies signatures by decoding the DID:key multicodec public key and importing it as an Ed25519 key
- `kid` (Key ID) in JWS headers references the DID + public key multibase

**Tools:**
| Tool | Purpose |
|------|---------|
| `did_show` | Display this agent's DID, public key, creation date |
| `did_sign` | Sign an arbitrary payload with Ed25519, return JWS |
| `did_verify` | Verify a signature against the public key carried by a DID:key |

**Files created:**
- `~/.pi/identity/did.json` — persistent DID + private key

### Module 2: AP2-style Agent Payments

**Reference:** Inspired by the official [Google Agentic Commerce AP2 repository](https://github.com/google-agentic-commerce/AP2). This module borrows the quote → approval → payment → receipt lifecycle, but it is not an AP2 network implementation or conformance claim.

**Implementation:**
- Mock wallet with initial balance of $1000 (simulated "pi-bucks", no real money)
- Four-stage payment lifecycle:
  1. **Quote request** — Agent calls `ap2_request_quote(task, budget)` → returns `quote_id` with estimated price
  2. **Human approval** — `ap2_pay` calls the pi UI confirmation API and aborts without mutation if declined
  3. **Payment execution** — Deducts from wallet, generates invoice ID and receipt ID
  4. **Ledger recording** — Wallet, quotes, and transaction arrays are revalidated and atomically replaced while holding a cross-process file lock
- Smart price estimation: price scales with task word count + complexity signals (code keywords like "implement", "debug", "database", etc.)
- Safety checks: insufficient funds, expired/already-paid quote, strict budget/max amount checks, and concurrent duplicate-payment prevention

**Tools:**
| Tool | Purpose |
|------|---------|
| `wallet_balance` | Check balance, total spent/received stats |
| `ap2_request_quote` | Get a price quote for a task from an agent |
| `ap2_pay` | Approve and pay a quote (requires explicit user intent) |

**Commands:**
| Command | Purpose |
|---------|---------|
| `/wallet balance` | Show current balance |
| `/wallet history` | Show last 10 transactions |
| `/wallet send <did> <amount>` | Send tokens to another DID |
| `/wallet deposit [amount]` | Add test funds (dev only) |

**Files created:**
- `~/.pi/economy/wallet.json` — wallet state
- `~/.pi/economy/ledger.json` — atomically replaced local transaction array (not an append-only/tamper-evident ledger)
- `~/.pi/economy/quotes.json` — pending/paid/expired quotes

### Module 3: Agent Discovery

**Standards referenced:**
- MCP Server discovery: Multiple public catalogs (mcpservers.org, Docker MCP Registry, GitHub awesome-mcp-servers) with curated fallback
- A2A discovery: Local registry of known agents (populated via auto-discovery from agent cards)

**Implementation:**
- **Public MCP search**: Tries multiple public MCP catalog APIs (with 5-second timeout per endpoint), falls back to a curated list of 10 well-known MCP servers
- **Local A2A registry**: JSON-based store of known agents (URL, name, description, skills, price per task, DID)
- **Auto-registration**: `/a2a-register <url>` command fetches the agent card automatically via A2A SDK's `ClientFactory.createFromUrl()` and fills in name/description/skills
- **Capability search**: `a2a_find_agents(capability)` searches by name, description, or skill tags
- **Tools register themselves**: `a2a_register_agent` tool lets the LLM register agents it discovers

**Tools:**
| Tool | Purpose |
|------|---------|
| `mcp_search_servers(query)` | Search public MCP catalog for servers |
| `a2a_find_agents(capability)` | Search local registry by capability/skill |
| `a2a_register_agent(url, name, ...)` | Register an agent in local registry |

**Commands:**
| Command | Purpose |
|---------|---------|
| `/mcp-search <keyword>` | Search MCP catalog interactively |
| `/a2a-register <url>` | Register an A2A agent (auto-discovers card) |
| `/a2a-list` | List all registered agents |
| `/economy` | Show overall economy module status |

**File created:**
- `~/.pi/economy/agent-registry.json` — local agent registry

## Usage

### Loading the extension

```bash
# Load along with other extensions:
pi -e extensions/memory.ts -e extensions/mcp.ts -e extensions/a2a/index.ts -e extensions/economy/index.ts
```

Upon first load, the extension automatically:
1. Generates a persistent DID:key identity in `~/.pi/identity/`
2. Creates a mock wallet with $1000 pi-bucks
3. Injects a system prompt note making the LLM aware of available economy tools
4. Registers all tools and slash commands

### Example workflow: discover and pay a remote agent

```
User: Find an agent that can do math calculations, get a quote for calculating 100 factorial, and pay up to $1.

pi calls a2a_find_agents("math")
  → Found 1 agent: "Math Agent" at http://localhost:42000, price $0.05/task

pi calls ap2_request_quote(agent_url="http://localhost:42000", task="Calculate 100!", budget_usd=1.00)
  → Quote qt_abc123: $0.03 USD, expires in 5 min

pi calls ap2_pay(quote_id="qt_abc123", max_amount=0.05)
  → ✅ Payment complete!
  → Receipt rcpt_xyz, invoice inv_789
  → New balance: $999.97
  → (Then pi would delegate the task via a2a_delegate from Phase 4)
```

### Viewing identity

```
/did show
  DID: did:key:z6MkhuhaMBCh9Jfwig4ffa...
  Public key: z6MkhuhaMBCh9Jfwig4ffa...
  Created: 2026-08-07T...
```

### Searching for MCP servers

```
/mcp-search browser
  @playwright/mcp: Browser automation via Playwright
  chrome-devtools-mcp: Chrome DevTools protocol integration
```

## Test Results

The extension-level test imports the real extension and checks 17 end-to-end assertions. Run it from `pi-main/` with:

```bash
./node_modules/.bin/tsx packages/coding-agent/examples/extensions/economy/scripts/test-economy.mjs
```

The test covers isolated key storage, independent `jose` verification of compact JWS, valid/tampered verification, over-budget quote rejection, declined payment with no mutation, confirmed payment with exact deduction, two concurrent payments producing exactly one receipt/deduction, and registration through a live local A2A agent card.

## Design Decisions & Tradeoffs

| Decision | Rationale |
|----------|-----------|
| **Mature crypto/encoding libraries + official protocol SDK** | Node provides Ed25519 primitives, `jose` implements standard compact JWS, `multiformats` implements base58btc, and the official A2A SDK avoids hand-rolling agent-card discovery |
| **DID:key method (not web5-js)** | DID:key is the simplest self-contained DID method (no ledger, no resolver needed). web5-js is heavyweight and has complex setup; for agent-to-agent identity verification, did:key is sufficient |
| **Mock wallet, not real crypto/fiat** | AP2 is still an early specification; real payment rails (crypto/x402/Stripe test mode) would add significant complexity without adding resume value at the experimental stage |
| **JSON files over SQLite** | Economy module data volume is tiny (few KB even after hundreds of transactions); JSON files are human-readable/auditable; no migration path needed |
| **Human-in-the-loop enforced** | Interactive `ap2_pay` calls invoke the pi UI confirmation API before entering the locked mutation path; declining leaves wallet, quote and ledger unchanged |
| **Curated fallback for MCP search** | Public MCP catalog APIs are inconsistent and may be unavailable; curated fallback ensures the tool always returns useful results |

JSON files remain an experimental local store: `proper-lockfile` plus atomic rename protects concurrent updates, but this is not a database transaction across crashes and does not make the ledger tamper-evident.

## Limitations & Future Work

### Current v0.1 Limitations

1. **No Verifiable Credentials (VCs)**: Only bare DID + JWS signing/verification, no VC issuance/verification
2. **No push notifications for payments**: Payment event webhooks are not implemented
3. **Mock currency only**: pi-bucks are fictional; no real USD/crypto integration
4. **Single-agent wallet**: No multi-account or HD wallet support
5. **Local-only discovery**: No peer-to-peer discovery or federated registry

### Future Enhancements (if the protocols mature)

- x402 (HTTP 402 Payment Required) header support for paid API endpoints
- VC issuance for agent capabilities ("this agent is certified for secure code review")
- Integration with the A2A extension to auto-pay when delegating tasks to paid agents
- Optional real payment rails (Stripe test mode, USDC on testnet)
- Shared local network registry via mDNS for LAN agent discovery

## Files

| File | Purpose |
|------|---------|
| `extensions/economy/package.json` | Package metadata and pinned workspace/runtime dependencies |
| `extensions/economy/index.ts` | Main extension: identity + payments + discovery |
| `extensions/economy/scripts/test-economy.mjs` | Real extension E2E test (17 assertions) |

## Resume Talking Point

**"Experimental integration of agent economy primitives: DID:key identity with standard compact EdDSA JWS (`jose` + `multiformats`), an explicitly local AP2-inspired quote-to-payment simulator with UI approval and concurrency-safe JSON mutation, and multi-source agent discovery using the official A2A SDK. It does not claim AP2 conformance or real payment-rail integration."**

Interpretation for interviewers:
- Frame as **tracking and experimenting with emerging standards** (not production-grade)
- DID/VC is the W3C standard for self-sovereign identity, increasingly adopted in agent frameworks
- AP2 is an emerging Google-led agent-commerce project; describe this implementation as a simulator derived from its lifecycle, not as a production AP2 integration
- The key insight is designing for human agency (explicit payment approval) even in autonomous agent systems
