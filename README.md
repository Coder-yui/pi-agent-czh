# pi-agent-czh — 基于 pi 的现代 Agent Harness

`pi-agent-czh` 以 [pi](https://github.com/earendil-works/pi-mono) 的极简 AgentSession、工具系统和多模型运行时为基础，接入了现代 agent harness 常见的协议、工作流、安全、记忆、评测和多 Agent 能力。

这个项目的目标不是重新实现成熟协议，而是使用官方 SDK 或成熟运行时完成适配，让这些能力能被 pi 的模型真实发现、调用、组合，并接受可重复的端到端验证。

## 新增能力

| 模块 | 已实现的能力 | 采用的成熟方案 |
|---|---|---|
| MCP Client | stdio/Streamable HTTP、工具/资源/提示词挂载、分页和动态刷新 | 官方 Model Context Protocol TypeScript SDK |
| Memory | 长期知识图谱、相关记忆注入、跨进程 JSONL 持久化、顺序一致的状态型工具调用 | 官方 MCP Memory Server |
| ACP | 编辑器协议握手、会话、权限桥接、工具与文本增量流、取消和关闭 | 官方 Agent Client Protocol SDK |
| Sandbox | OS 级隔离、致命命令过滤、项目策略、审计和 fail-closed 模式 | Anthropic Sandbox Runtime |
| Plan/Reflect | 自动规划提示、错误反思、重复失败检测和确定性重试阻断 | pi extension lifecycle hooks |
| Evals | 隔离工作区、真实代码执行、judge 评分和多模型评测入口 | Vitest Evals |
| A2A | Agent Card、JSON-RPC/流式任务、失败与取消、远程 Agent 委派 | Google A2A SDK/协议 |
| Agent Economy | DID:key、Ed25519/JWS、Agent 发现、报价、确认式模拟支付和幂等账本 | `jose`、DID:key 与 AP2 风格流程 |
| Agent Loop | 完整 AgentSession 多轮续跑、显式 checkpoint、暂停/恢复、迭代/工具/时间硬预算 | Google ADK LoopAgent 控制模式 |
| Agent Graph | 校验后的图定义、条件路由、纠错循环、审批节点、取消和隔离 pi 节点 | 官方 LangGraph.js `StateGraph` |

每个扩展的实现范围、命令、测试和明确边界记录在 [扩展实施文档](docs/phases/README.md)；Agent Loop 和 Agent Graph 还有各自的 [Loop README](packages/coding-agent/examples/extensions/agent-loop/README.md) 与 [Graph README](packages/coding-agent/examples/extensions/agent-graph/README.md)。

## 验证状态

仓库包含两层验证，避免把“注册了一个工具”误当成“能力已经接入”：

- 确定性 E2E：11/11 组通过，覆盖官方 server/SDK、协议生命周期、安全边界、持久化、条件路由、循环上限和取消。
- 真实模型 E2E：使用 `deepseek/deepseek-v4-pro` 完成 9/9 项集成测试；模型实际调用 MCP、Memory、Sandbox、Plan/Reflect、Economy，并通过 ACP/A2A、两轮 Agent Loop 和两节点 Agent Graph。
- 真实编程 Eval：DeepSeek 在隔离目录编写 `sum.js`、调用工具并运行测试，judge 得分 `1.00`。
- 工程检查：`npm run check` 和 `npm run build:offline` 通过。

```bash
# 无需模型凭据的全部确定性验证
node docs/scripts/verify-all.mjs

# 真实模型编程 eval（provider/model 可替换）
PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-pro node docs/scripts/verify-all.mjs 3

# 真实模型驱动全部现代 Agent 接入
npm run build:offline
PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-pro node docs/scripts/verify-live-model.mjs
```

DeepSeek 可以在 pi 中执行 `/login deepseek` 配置；凭据保存在 `~/.pi/agent/auth.json`，不写入仓库。

## 与上游 pi 的关系

本仓库保留 pi 原有 runtime、CLI、provider 和文档体系，新增能力主要位于 `packages/coding-agent/examples/extensions/` 与 `docs/phases/`。下面保留上游项目 README，便于继续查阅 pi 本身的构建、包结构和开发说明。

---

## 上游 pi README（保留）

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
