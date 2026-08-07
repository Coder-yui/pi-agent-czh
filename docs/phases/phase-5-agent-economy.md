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

All three use **zero external dependencies** beyond Node.js built-in modules (`crypto`, `fs`, `path`), making them lightweight and avoiding native compilation issues.

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
- Generates an Ed25519 keypair using Node.js native `crypto.generateKeyPairSync('ed25519')` (no external crypto libraries)
- Public key is encoded using multicodec (`0xed01` for Ed25519) + base58btc multibase (`z` prefix) to produce the DID: `did:key:z6Mk...`
- Private key is stored only in `~/.pi/identity/did.json` (file permissions respected, never transmitted)
- Signs payloads using JWS (JSON Web Signature) with EdDSA algorithm
- `kid` (Key ID) in JWS headers references the DID + public key multibase

**Tools:**
| Tool | Purpose |
|------|---------|
| `did_show` | Display this agent's DID, public key, creation date |
| `did_sign` | Sign an arbitrary payload with Ed25519, return JWS |

**Files created:**
- `~/.pi/identity/did.json` — persistent DID + private key

### Module 2: AP2-style Agent Payments

**Standard:** Following the [Agent Payments Protocol (AP2)](https://ap2lab.com/) pattern from Google Agentic Commerce (announced September 2025, 60+ industry partners). AP2 defines quote → authorization → payment → receipt flows for agent commerce.

**Implementation:**
- Mock wallet with initial balance of $1000 (simulated "pi-bucks", no real money)
- Four-stage payment lifecycle:
  1. **Quote request** — Agent calls `ap2_request_quote(task, budget)` → returns `quote_id` with estimated price
  2. **Human approval** — Payment requires explicit `ap2_pay(quote_id, max_amount)` call, enforcing human-in-the-loop
  3. **Payment execution** — Deducts from wallet, generates invoice ID and receipt ID
  4. **Ledger recording** — All transactions recorded in append-only JSON ledger
- Smart price estimation: price scales with task word count + complexity signals (code keywords like "implement", "debug", "database", etc.)
- Safety checks: insufficient funds detection, expired quote detection, max amount enforcement

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
- `~/.pi/economy/ledger.json` — append-only transaction ledger
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

34 self-contained tests covering all three sub-modules (run: `node scripts/test-economy.mjs`):

```
[Module 1] DID:key Identity
  ✓ DID starts with "did:key:z"
  ✓ Public key multibase starts with "z"
  ✓ Public key has reasonable length (48 chars)
  ✓ Signature generated (86 chars, base64url)
  ✓ Signature uses base64url (no + or /)
  ✓ JWS has 3 parts (header.payload.signature)
  ✓ JWS header alg is EdDSA
  ✓ JWS kid references the signer DID
  ✓ JWS payload includes issued-at timestamp
  ✓ JWS payload contains custom claims
  ✓ Two generated identities have different DIDs
  ✓ Two generated identities have different private keys

[Module 2] AP2-style Payments
  ✓ Initial wallet balance is $1000
  ✓ Simple task price is small: $0.01
  ✓ Complex task costs more than simple
  ✓ Quote saved
  ✓ Balance decreased after payment
  ✓ Quote state is 'paid' after payment
  ✓ Ledger has one payment entry
  ✓ Ledger entry type is 'payment'
  ✓ Ledger entry references invoice ID
  ✓ Correctly detects insufficient funds
  ✓ Deposit works
  ✓ Ledger accumulates entries

[Module 3] Agent Discovery
  ✓ Registry starts empty
  ✓ Registered 4 agents
  ✓ Found 2 coding agents
  ✓ Found 1 math agent
  ✓ Math agent correctly identified
  ✓ Found 2 agents with refactoring capability
  ✓ Updating existing URL doesn't create duplicate
  ✓ Update correctly applied
  ✓ Curated MCP fallback finds GitHub server
  ✓ Curated MCP fallback finds browser server

Results: 34 passed, 0 failed
```

## Design Decisions & Tradeoffs

| Decision | Rationale |
|----------|-----------|
| **Zero external dependencies** | Node 18+ has native Ed25519 via `crypto`; JSON files for storage are sufficient for an experimental module; avoids `better-sqlite3` native compilation pain |
| **DID:key method (not web5-js)** | DID:key is the simplest self-contained DID method (no ledger, no resolver needed). web5-js is heavyweight and has complex setup; for agent-to-agent identity verification, did:key is sufficient |
| **Mock wallet, not real crypto/fiat** | AP2 is still an early specification; real payment rails (crypto/x402/Stripe test mode) would add significant complexity without adding resume value at the experimental stage |
| **JSON files over SQLite** | Economy module data volume is tiny (few KB even after hundreds of transactions); JSON files are human-readable/auditable; no migration path needed |
| **Human-in-the-loop enforced** | Payments require an explicit `ap2_pay` tool call separate from quote request, ensuring the LLM cannot spend money without user intent being clear in the conversation |
| **Curated fallback for MCP search** | Public MCP catalog APIs are inconsistent and may be unavailable; curated fallback ensures the tool always returns useful results |

## Limitations & Future Work

### Current v0.1 Limitations

1. **No real DID verification**: `verifySignature()` is permissive for unknown DIDs; full verification requires decoding base58 + multicodec + Ed25519 verify against raw public key
2. **No Verifiable Credentials (VCs)**: Only bare DID + JWS signing, no VC issuance/verification
3. **No push notifications for payments**: AP2 specifies webhook callbacks for payment events; not implemented
4. **Mock currency only**: pi-bucks are fictional; no real USD/crypto integration
5. **Single-agent wallet**: No multi-account or HD wallet support
6. **Local-only discovery**: No peer-to-peer discovery or federated registry

### Future Enhancements (if the protocols mature)

- Full DID verification with base58 decode + Ed25519 verify
- x402 (HTTP 402 Payment Required) header support for paid API endpoints
- VC issuance for agent capabilities ("this agent is certified for secure code review")
- Integration with the A2A extension to auto-pay when delegating tasks to paid agents
- Optional real payment rails (Stripe test mode, USDC on testnet)
- Shared local network registry via mDNS for LAN agent discovery

## Files

| File | Purpose |
|------|---------|
| `extensions/economy/package.json` | Package metadata (zero external deps) |
| `extensions/economy/index.ts` | Main extension: identity + payments + discovery |
| `extensions/economy/scripts/test-economy.mjs` | Self-contained test (34 tests, all passing) |

## Resume Talking Point

**"Experimental integration of agent economy primitives: W3C DID:key decentralized identity with Ed25519 JWS signing, AP2-aligned quote-to-payment flow with human-in-the-loop approval and local ledger, and multi-source agent discovery (public MCP catalog + local A2A registry). Zero external dependencies using Node.js native crypto."**

Interpretation for interviewers:
- Frame as **tracking and experimenting with emerging standards** (not production-grade)
- DID/VC is the W3C standard for self-sovereign identity, increasingly adopted in agent frameworks
- AP2 is Google's bet on agent commerce with 60+ industry partners (Visa, Stripe, Shopify)
- The key insight is designing for human agency (explicit payment approval) even in autonomous agent systems
