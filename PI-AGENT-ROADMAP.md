# pi-mono 前沿 Agent 能力扩展路线图

> 目标：以**不侵入核心、以 extension + 独立 package** 方式，在极简 harness (pi-mono) 上搭建一套覆盖 **协议层 / 认知层 / 执行层 / 评测层 / 经济层** 的完整前沿 Agent 能力矩阵，作为简历项目。
>
> 核心原则：**不重造轮子**，所有协议/SDK 用现成开源实现做接入；只写 glue code + 适配层。

---

## 模块总览

| 阶段 | 模块 | 优先级 | 位置 | 说明 |
|---|---|---|---|---|
| Phase 1 | **MCP Client** | P0 | `packages/coding-agent/examples/extensions/mcp/` | 基于官方 `@modelcontextprotocol/sdk`，支持 stdio + Streamable HTTP，tools/resources/prompts 挂载 |
| Phase 1 | **Memory 系统** | P0 | `packages/coding-agent/examples/extensions/memory/` | 接入 `@modelcontextprotocol/server-memory` 作为 Knowledge Graph 后端 |
| Phase 2 | **ACP 适配层** | P0 | `packages/coding-agent/examples/extensions/acp/` | 基于 `@agentclientprotocol/sdk`，同进程嵌入 AgentSession，双向事件流桥接 |
| Phase 2 | **Sandbox 执行** | P0 | `packages/coding-agent/examples/extensions/sandbox/` | 双层防御：致命命令拦截 + OS 级沙箱（sandbox-exec/bubblewrap） |
| Phase 3 | **Planning & Reflection** | P1 | `packages/coding-agent/examples/extensions/plan-reflect/` | ReAct/Reflexion 模式：计划注入 + 错误反思 + 重试熔断 |
| Phase 3 | **Agentic Evaluation Framework** | P1 | `packages/evals/` | 基于 `vitest-evals`：dataset/solver/scorer 三段式，多模型对比，轨迹/成本记录 |
| Phase 4 | **A2A 双向适配** | P2 | `packages/coding-agent/examples/extensions/a2a/` | Google Agent2Agent 协议：跨 agent 任务委派、artifact 传递 |
| Phase 4 | **Agent Economy** | P2 | 待规划 | Identity/AP2/Discovery 生态层 |

> 各阶段实施结果见 [`docs/phases/`](./docs/phases/) 目录。

---

## 零、项目结构建议

```
pi-main/
├── packages/
│   ├── agent/                 # 已有，harness 核心（不改）
│   ├── ai/                    # 已有，模型 provider（不改）
│   ├── client/                # 已有，unix client（不改）
│   ├── coding-agent/          # 已有，TUI + extensions loader（不改或加 hook）
│   ├── evals/                 # 【新增】Agentic Evaluation Framework
│   └── ...
└── extensions/                # 【新增】前沿能力都以 extension 形式挂载
    ├── mcp/                   # 模块1：MCP Client
    ├── memory/                # 模块2：记忆系统
    ├── acp/                   # 模块3：ACP 适配层
    ├── sandbox/               # 模块4：Sandbox 执行
    ├── plan-reflect/          # 模块5：Planning & Reflection
    ├── a2a/                   # 模块7：A2A 节点
    └── economy/               # 模块8：Agent Economy（identity/payment/discovery）
```

pi 的扩展入口点全部来自 `packages/coding-agent` 提供的 `ExtensionAPI`（见 [extensions.md](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/docs/extensions.md) 与 [examples/extensions/dynamic-tools.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/dynamic-tools.ts)），核心挂载点：

- `pi.registerTool()` — 注入自定义工具
- `pi.on("tool_call" | "before_request" | "after_response" | "session_start" | "session_end")` — 事件拦截
- `pi.appendEntry()` / `pi.getContext()` — 持久化与上下文注入
- `pi.registerCommand()` — 自定义斜杠命令（如 `/plan`、`/reflect`）

协议适配层（ACP/A2A）不做 extension，因为它们要暴露网络接口，做成独立进程/包通过 `packages/client` 连接 pi 即可。

---

## ○、现成参考实现清单（抄这部分就行，别从零写）

> 先说真话：pi 目前**没有独立的第三方 extension marketplace**（不像 Claude Code 有 ClawHub/技能市场那么成熟）。但它的 extension API 是 TypeScript 函数式风格，非常简单，**其他 TS coding agent 的插件几乎可以直接平移**。下面是每个模块你可以"对着源码抄"的参考。

### pi 官方自带的"免费教材"（先全读一遍）

pi 自己的 [examples/extensions/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/) 有 **60+ 个示例 extension**，很多前沿概念已经有雏形：

| 你要做的能力 | 直接看哪个示例 |
|---|---|
| 动态注册/卸载工具（MCP 必备） | [dynamic-tools.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/dynamic-tools.ts) |
| 拦截/覆写内置工具（Sandbox 必备） | [tool-override.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/tool-override.ts) |
| 注入 system prompt header（Memory 必备） | [system-prompt-header.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/system-prompt-header.ts) |
| 自定义斜杠命令（/plan /memory 必备） | [commands.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/commands.ts) |
| 危险操作确认（Sandbox 审批参考） | [confirm-destructive.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/confirm-destructive.ts)、[permission-gate.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/permission-gate.ts) |
| 自定义 compaction 总结（Reflection 参考） | [custom-compaction.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/custom-compaction.ts)、[summarize.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/summarize.ts) |
| 会话间交接/handoff（A2A 参考） | [handoff.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/handoff.ts) |
| 子 agent 派发到 RPC（A2A/sandbox 参考） | [rpc-demo.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/rpc-demo.ts) |
| 持久化 state 到 session（Memory 必备） | [todo.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/todo.ts)、[bookmark.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/bookmark.ts) |
| 自定义压缩/总结 compaction | [custom-compaction.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/custom-compaction.ts) |
| 基于 pi SDK 写完全独立的 agent（ACP/A2A server 参考） | [examples/sdk/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/sdk/) 下 01-minimal ~ 12-full-control |

**OpenClaw（pi 的"亲儿子"商业产品）的 ClawHub** 上有大量基于 pi SDK 的技能，其中最值得抄的是 `self-improving-agent`（反思+沉淀 skill 的闭环）——直接对应你要做的 Planning & Reflection 模块。

### 跨竞品可直接抄的 MCP Client 实现

**不要自己写 MCP 连接、工具列表同步、schema 转换**——这部分 bug 很多，抄成熟实现：

| 参考项目 | 文件路径 / 重点 | 为什么值得抄 |
|---|---|---|
| [cline/cline](https://github.com/cline/cline)（VS Code 插件，TS） | `src/services/mcp/McpHub.ts` + `src/services/mcp/connectors/` | **MCP Client 实现的教科书**：多 server 生命周期管理、自动重连、健康检查、tool schema 转内部格式、资源/提示词订阅，全部都有。掘金有源码解读文章。 |
| [sst/opencode](https://github.com/sst/opencode)（终端 coding agent，TS，和 pi 最像） | `src/plugins/mcp/` 或 `internal/mcp/` | OpenCode 的插件机制有 25+ 生命周期钩子，MCP 是内置 plugin，TS 实现，**和 pi 的 extension 形态几乎 1:1 对应**，平移成本最低 |
| [CopilotKit/open-mcp-client](https://github.com/CopilotKit/open-mcp-client) | 整个仓库 | 通用 MCP Client，独立于任何 agent，可以当库直接在你的 extension 里 `import` |
| [continuedev/continue](https://github.com/continuedev/continue)（VS Code/JetBrains 开源 Copilot 替代） | `core/config/default.ts` + `core/context/mcp/` | MCP 配置文件解析 + 工具动态加载，适合参考"从 config 到可用 tool"的整条链路 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) 官方 examples | `examples/client/` 下的 `simple-client`、`cli-chat-client` | 最基础的 stdio/HTTP 连接示例，先跑通它 |

**抄的顺序建议**：先跑通官方 SDK 的 `simple-client` → 读 Cline 的 `McpHub.ts` 学架构 → 读 OpenCode 的 MCP plugin 学"agent 形态下的 MCP 挂载" → 再回来写 pi extension。

### Memory 现成方案（别自己写 embedding/检索）

| 参考 | 形态 | 用法 |
|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) JS SDK | npm 包 `mem0ai` | 接进来就是 API 调用：`add()`/`search()`/`get_all()`，自带 decay、去重、用户/会话/项目三层 namespace |
| [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)（C 写的 MCP server） | 独立 MCP server | **2026 GitHub Trending 榜首 (32k stars)**，3 分钟索引 Linux 内核 2800 万行，查 <1ms，Token 消耗降 120 倍。直接作为 MCP server 挂到你的 MCP Client 上就行，连代码库记忆 extension 都不用自己写向量库 |
| Claude Code 原生 `CLAUDE.md` + Auto Memory | 文件 + 规则 | 最轻量方案：[system-prompt-header.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/system-prompt-header.ts) 示例改个文件名就是这个能力，半天搞定 |
| [letta-ai/letta](https://github.com/letta-ai/letta) (原 MemGPT) | 独立服务 + JS SDK | 想要"stateful agent with memory"概念最完整的实现就学它，有 core/archival/recall 三层记忆抽象 |
| Google `agents-cli` 里的 memory skill | 单个 skill 文件 | 塞进 Claude Code/Codex 的 skill 目录就生效，学它的"自动抽取事实"prompt 怎么写 |

**推荐组合**：文件记忆（直接抄 CLAUDE.md）+ `codebase-memory-mcp`（代码库记忆走 MCP）+ mem0（用户/项目长期记忆走 SDK）。三个层次互不冲突，一周搞定。

### MCP Servers 现成工具集（不用自己写工具）

接好 MCP Client 之后，这些现成 server 直接挂，你的 agent 就自动拥有对应能力：

| 能力 | 现成 server |
|---|---|
| 本地文件系统读写 | `@modelcontextprotocol/server-filesystem`（官方） |
| GitHub 操作（issue/PR/搜索） | `@modelcontextprotocol/server-github`（官方） |
| PostgreSQL / SQLite 查询 | `@modelcontextprotocol/server-postgres` |
| 浏览器（Playwright） | `@playwright/mcp`、`chrome-devtools-mcp` |
| 代码库记忆 | codebase-memory-mcp（见上） |
| 搜索引擎 | `@modelcontextprotocol/server-brave-search`、`exa-mcp-server` |
| 一站式目录 | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)（官方集合）、[punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)、[mcphub](https://mcphub.cloud) |

### Sandbox 参考

| 参考 | 看哪里 |
|---|---|
| [openai/codex-cli](https://github.com/openai/codex) sandbox 实现 | Codex CLI 的 `src/sandbox/`——它是用 macOS Seatbelt / Linux Landlock 做的本地沙箱，值得看它的权限清单 |
| [e2b-dev/E2B](https://github.com/e2b-dev/E2B) JS SDK examples | `packages/sdk-js/examples/` 下有 code-interpreter、bash 执行的完整 TS 示例 |
| [microsandbox/microsandbox](https://github.com/microsandbox/microsandbox) | 官方 TS/JS SDK + MCP server（原生 MCP 支持意味着沙箱可以作为 MCP server 挂给任何 agent） |
| pi 自己的沙箱雏形 | [restore-sandbox-env.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/src/bun/restore-sandbox-env.ts) |

### Planning & Reflection 参考

| 参考 | 形态 |
|---|---|
| Google `agents-cli` 内置 7 个 skills（brainstorming、tdd、review 等） | 纯 markdown skill 文件，触发机制是命令，直接照抄成 pi 的 custom command + system-prompt-header |
| Reflexion 论文官方实现 | [noahshinn/reflexion](https://github.com/noahshinn/reflexion)（Python），抄它的 verbal reinforcement 反馈模板 |
| LangGraph 的 `create_react_agent` 中断机制 | 源码学"中断-人类确认-恢复"的状态机，**不要引 LangGraph 依赖** |
| pi 自带 todo + custom-compaction 组合 | [todo.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/todo.ts) + [custom-compaction.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/custom-compaction.ts) 拼起来就是 60% 的 plan mode |

### ACP / A2A 参考

| 参考 | 看哪里 |
|---|---|
| [zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol) | 协议 schema + TS SDK + sample server，直接起一个 sample server 跑通 Zed |
| [zed-industries/claude-code-acp](https://github.com/zed-industries/claude-code-acp) | **核心参考**：Claude Code 接 ACP 的官方适配器，架构和你接 pi 一模一样，看它怎么把 Claude Code SDK 映射成 ACP 方法，照搬成 pi-client 版本就行 |
| [google/A2A](https://github.com/google/A2A) | 官方 TS SDK + samples/js/ 下有 `client/`、`server/`、`agent/` 完整可运行示例 |
| [ai-boost/awesome-a2a](https://github.com/ai-boost/awesome-a2a) | 生态项目索引 |

### Agentic Evals 参考

| 参考 | 看哪里 |
|---|---|
| [UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai) | `src/inspect_ai/_eval/` 看 task/solver/scorer 三段式架构；`scorers/`、`solvers/` 抄大量实用实现 |
| [princeton-nlp/SWE-agent](https://github.com/princeton-nlp/SWE-agent) | `sweagent/agent/` 看 agent trajectory 记录格式；`sweagent/environment/` 看 docker 沙箱怎么管理测试环境 |
| [sierra-research/tau-bench](https://github.com/sierra-research/tau-bench) | 纯 Python 但很轻，看它的 user simulator 怎么写（pi 里可以用 faux provider 模拟用户） |
| pi 自己的测试 harness | [agent-loop.test.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/agent/test/agent-loop.test.ts) + [faux provider](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/ai/src/providers/faux.ts) + [session testing](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/agent/src/harness/session/testing/index.ts)，evals 包直接复用这一套做 deterministic 单测，不烧钱 |

### Agent Economy 参考

| 子模块 | 参考 |
|---|---|
| Identity (DID/VC) | [TBD54566975/web5-js](https://github.com/TBD54566975/web5-js)（Block 公司，JS SDK 最完整）；[decentralized-identity/did-jwt](https://github.com/decentralized-identity/did-jwt) |
| AP2 支付 | 官方中文社区 <https://ap2lab.com> 有示例代码；协议由 Google Agentic Commerce 发起，GitHub 上搜索 `ap2 protocol` 能拿到样例仓库 |
| Discovery | [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)（GitHub 官方 MCP Registry，API 直接调）；A2A Agent Card 发现直接用 HTTP GET `/.well-known/agent-card.json` |

---

## 模块 1：MCP Client（优先级 P0）

> 实施结果见 [docs/phases/phase-1-mcp-memory.md](./docs/phases/)

**目标**：让 pi 能挂载任意 MCP 2026-07-28（无状态）Server，其 tools/resources/prompts 自动注册给 LLM。

### 参考实现（不要自己写协议）

| 用途 | 仓库 / 包 |
|---|---|
| 官方 TS SDK（实际使用 `@modelcontextprotocol/sdk@^1.30.0`，v2 在开发中未发布） | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| 多 server 管理参考 | VS Code Copilot MCP 接入逻辑（`@modelcontextprotocol/inspector` 可参考 UI 思路） |
| 动态工具注册样例 | pi 自带 [dynamic-tools.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/dynamic-tools.ts) |

---

## 模块 2：记忆系统 Memory（P0）

> 实施结果见 [docs/phases/phase-1-mcp-memory.md](./docs/phases/)

**目标**：让 agent 拥有跨会话的长期记忆，能主动记住用户偏好、项目约定、关键决策。

### 参考实现（实际使用的）

| 层 | 实际选型 | 说明 |
|---|---|---|
| 知识图谱存储/检索后端 | [`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory)（Anthropic 官方） | 通过 MCP stdio 子进程方式 spawn，entities/relations/observations 三元组模型，内置 `search_nodes`，JSONL 持久化，每次操作后立即写盘 |
| 通信协议 | `@modelcontextprotocol/sdk` Client（和 MCP 扩展复用同一 SDK） | 不引入 mem0 等额外依赖，减少 runtime 复杂度；后续若需要语义向量检索，可再加 mem0-mcp server 通过 MCP 扩展挂载（零代码改动） |
| System prompt 注入参考 | pi 自带 [system-prompt-header.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/system-prompt-header.ts) | 通过 `before_agent_start` 事件返回 `{systemPrompt: ...}`，pi 负责链式拼接多个扩展的 prompt 段 |

---

## 模块 3：ACP 适配层（P0，简历差异化杀器）

> 实施结果见 [docs/phases/phase-2-acp-sandbox.md](./docs/phases/)

**目标**：把 pi 包装成 [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) Agent，使 Zed / JetBrains AI Assistant 等任何实现 ACP 的编辑器能直接调用 pi 作为 coding agent。

### 参考实现（实际使用的）

| 用途 | 选型 | 说明 |
|---|---|---|
| 协议规范 + TS SDK（实际使用 `@agentclientprotocol/sdk@^1.3.0`） | [`zed-industries/agent-client-protocol`](https://github.com/zed-industries/agent-client-protocol) | 官方 TypeScript SDK，提供 Agent/Client 两端的类型、ndjson 流、ActiveSession 助手；不需要自己写 JSON-RPC 解析 |
| 适配器架构参考 | [`zed-industries/claude-code-acp`](https://github.com/zed-industries/claude-code-acp) | Claude Code 官方接入 ACP 的参考实现，展示了如何把 agent SDK 事件映射为 ACP session/update 通知 |
| pi 进程内 SDK | pi 自带 [examples/sdk/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/sdk/) 的 `createAgentSession` | **同进程集成**而非走 `packages/client` RPC 子进程，更轻量，避免双进程序列化开销 |

---

## 模块 4：Sandbox 执行层（P1）

> 实施结果见 [docs/phases/phase-2-acp-sandbox.md](./docs/phases/)

**目标**：防止 agent 意外执行破坏性命令（`rm -rf /`、fork bomb、mkfs 等），并对所有 bash 命令施加 OS 级文件系统 + 网络隔离。

---

## 模块 5：Planning & Reflection（P1）

> 实施结果见 [docs/phases/phase-3-plan-reflect-evals.md](./docs/phases/)

**目标**：让 agent 在复杂任务前显式建计划、工具失败时触发反思、避免盲目重试死循环。

---

## 模块 6：Agentic Evaluation Framework（P1，`packages/evals`）

> 实施结果见 [docs/phases/phase-3-plan-reflect-evals.md](./docs/phases/)

**目标**：系统性评估 pi agent 能力，跑 benchmark 出分数/报告，形成"造 agent 也会测 agent"的完整闭环。

---

## 实施记录

已完成阶段的详细实施记录（能力清单、配置示例、架构决策、测试覆盖、简历话术等）见 [`docs/phases/`](./docs/phases/) 目录：

| 阶段 | 模块 | 实施记录 |
|---|---|---|
| Phase 1 | MCP Client + Memory 系统 | [phase-1-mcp-memory.md](./docs/phases/phase-1-mcp-memory.md) |
| Phase 2 | ACP 适配层 + Sandbox 执行 | [phase-2-acp-sandbox.md](./docs/phases/phase-2-acp-sandbox.md) |
| Phase 3 | Planning & Reflection + Agentic Evals | [phase-3-plan-reflect-evals.md](./docs/phases/phase-3-plan-reflect-evals.md) |

---

## 模块 7：A2A 协议（P2）

**目标**：让两个 pi 实例（或 pi 与任何 A2A agent）能互派任务、互传 artifact。

### 参考实现

| 用途 | 仓库 |
|---|---|
| 官方协议 + SDK（Python/TS/Java 都有） | [`google/A2A`](https://github.com/google/A2A)，官网 <https://google.github.io/A2A> |
| Agent Card 规范 | A2A 仓库里的 `agent-card.json` schema + well-known URL 发现 |
| 生态资源 | [`ai-boost/awesome-a2a`](https://github.com/ai-boost/awesome-a2a) |

### 接入点
- 两部分：**(a) pi 作为 A2A Server**（被其他 agent 调用）+ **(b) pi 作为 A2A Client**（调其他 agent）
- **Server**：独立包 `packages/a2a-server`，和 ACP server 类似——起 HTTP 服务，暴露 `/.well-known/agent-card.json` 和 `/tasks/send`、`/tasks/get` 等 JSON-RPC 端点
- **Client**：extension `extensions/a2a`，注册工具 `a2a_delegate(agentUrl, task)` 让 pi 主 agent 可以把子任务派给别的 A2A agent（参考 pi 自带的 [handoff.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/handoff.ts)）
- 关键映射：A2A Task lifecycle (submitted → working → input-required → completed) ↔ pi session lane 状态（参考 harness-v2 lanes 设计）

### 实现步骤
1. 起个最小 A2A server：暴露 agent card（名字、能力描述、skills、输入模态），接受简单文本 task 返回文本 reply
2. 把 task 接到 pi client：收到 task → send prompt 给本地 pi session → 把事件流转成 A2A TaskStatusUpdateEvent
3. 实现 Push Notification / streaming
4. 做 client 侧工具：通过 A2A 发现 agent（读 well-known card）→ 发任务 → 等结果
5. Demo：启动两个 pi A2A 节点，一个"researcher"一个"coder"，主 agent 让 researcher 查资料再让 coder 写代码

### 验收
- 用 A2A 官方 sample client 能调起 pi 节点完成任务。
- 简历话术：**"实现 Google A2A 协议双向适配，支持 Agent Card 发现、Task 流式状态推送、artifact 传递，使 pi 可加入异构多 agent 协作网络"**。

---

## 模块 8：Agent Economy 三件套（P2，前沿加分项）

> ⚠️ **成熟度警告**：这部分协议都还在早期草案/社区阶段，不是像 MCP/A2A 那样稳定。简历里要如实写"跟踪/实验性接入"，面试官追问细节不会穿帮。

### 8.1 Agent Identity — 身份认证与授权

**现状校正**：Google **没有**一个独立命名的 "Agent Identity Protocol (AIP)" 官方协议。业界目前是几个组件拼起来的：

| 组件 | 参考 |
|---|---|
| Agent 身份标识 | W3C [Decentralized Identifiers (DIDs)](https://www.w3.org/TR/did-core/) + [Verifiable Credentials](https://www.w3.org/TR/vc-data-model/) |
| Agent Card 身份 | A2A Agent Card schema 里的 `url`/`authentication` 字段（支持 OAuth2、API Key） |
| AP2 里的 Agent 身份 | AP2 规范自带 agent 身份声明（因为支付必须验身份） |
| 具体实现参考 | [`web5-sdk-js`](https://github.com/TBD54566975/web5-js)（Block 公司的 DID/VC JS SDK，直接接）；A2A SDK 的 AgentCard auth 字段 |

**实现路径**：
- Extension `extensions/economy/identity.ts`
- 启动时为 pi 生成本地 DID（存 `~/.pi/identity/`）
- 把 DID + 能力 VC 挂载到 A2A/ACP/AP2 的 agent card 里
- 对外发请求（MCP/A2A/AP2）时用 DID 签名 HTTP header（参照 VC-DI HTTP signature draft）
- 收到请求时校验对方 DID
- 简历话术：**"基于 W3C DID/VC 规范实现 agent 去中心化身份，签名请求、可验证凭证授权，为多 agent 经济交互提供身份基础"**。

### 8.2 AP2 — Agent Payments Protocol 跨 agent 支付

**真实存在**：由 **Google Agentic Commerce 团队**发起（不是社区炒概念），官方中文社区 ap2lab.com，规范开源。

| 用途 | 参考 |
|---|---|
| 协议规范 | AP2 官方仓库（Google Agentic Commerce 发起），<https://ap2lab.com> 中文社区 |
| 接入文章 | InfoQ《探索 Agent Payments Protocol (AP2)：构建智能支付代理的开源方案》 |
| 行业合作 | Visa、Shopify、Stripe 是首批合作方 |

**接入点**：
- Extension `extensions/economy/payment.ts`
- 注册工具 `ap2_request_quote(agentDid, taskDesc, budget)` / `ap2_pay(invoiceId)` / `ap2_accept_payment(invoice)`
- 实现 AP2 的 quote → invoice → payment → receipt 四阶段流程
- 钱包：先用本地 mock 钱包（记录 ledger 到 sqlite），再接测试网（Solana/Polygon）或 Stripe test mode
- 和 A2A 模块联动：A2A delegate 工具在需要付费调用其他 agent 时自动走 AP2 流程（用户确认后支付）

**简历话术**：**"实验性接入 Google Agentic Commerce 团队发起的 AP2 协议，实现 agent 间报价-发票-支付-结算闭环，支持人在回路 (human-in-the-loop) 支付审批"**。

### 8.3 Agent Discovery — Agent 能力注册与发现

**现状校正**：目前没有独立的"ADP"协议。Discovery 功能被三个现有机制承载：

| 机制 | 参考 |
|---|---|
| MCP Server 发现 | [GitHub MCP Registry](https://github.com/modelcontextprotocol/registry)（事实标准，2026 年 GitHub 官方推出） |
| A2A Agent 发现 | 标准 A2A Agent Card + 企业 registry（A2A 规范里有 extended discovery 章节） |
| 企业私有注册中心 | 多家厂商（Copilot、Bedrock）都在做私有的 agent registry |

**实现路径**：
- Extension `extensions/economy/discovery.ts`
- 对接 MCP Registry API：`pi.registerCommand("/mcp-search <keyword>")` 搜索并一键挂载 MCP server
- 做一个本地 agent registry（sqlite）：把 A2A/ACP agent card 登记进去，提供 `a2a_discover(capability)` 工具
- 可选：把自己的 agent card 发布到本地 registry，形成局域网内 agent 互发现
- 简历话术：**"对接 GitHub MCP Registry + A2A Agent Card discovery 机制，实现 agent 能力的注册、语义检索与一键挂载"**。

---

## 整体实施顺序与时间估算

| 阶段 | 模块 | 难度 | 预计工作量 | 前置依赖 |
|---|---|---|---|---|
| Phase 1 | MCP Client | ⭐⭐ | 3-4 天 | 无 |
| Phase 1 | Memory 系统（文件+向量两层） | ⭐⭐ | 3 天 | 无（可与 MCP 并行） |
| Phase 2 | ACP 适配层 | ⭐⭐⭐ | 4-5 天 | 要先读懂 client 包 |
| Phase 2 | Sandbox | ⭐⭐ | 3 天 | MCP（可选，MCP 形式暴露沙箱） |
| Phase 3 | Planning & Reflection | ⭐⭐⭐ | 4 天 | Memory（沉淀反思） |
| Phase 3 | `packages/evals` 骨架 + SWE-bench Lite | ⭐⭐⭐⭐ | 6-7 天 | 前面全部模块都能被测 |
| Phase 4 | A2A 双向适配 | ⭐⭐⭐ | 4-5 天 | ACP 的经验可复用 |
| Phase 4 | Agent Economy（Identity + AP2 + Discovery） | ⭐⭐⭐⭐ | 7-10 天 | A2A + Memory |

总计约 5-7 周业余工作量，按简历优先级建议至少做到 Phase 3（MCP + Memory + ACP + evals 骨架），这样已经是非常扎实的简历项目。

---

## 简历项目包装建议

**项目名建议**：`pi-forge` 或 `pi-agent-kit`（不是 fork pi，而是以 pi 为 harness 核心的能力扩展套件）。

**一句话描述**：*"基于极简 agent harness (pi-mono) 构建的前沿能力矩阵，覆盖 MCP 2026/ACP/A2A/AP2 协议栈、三层记忆、规划反思闭环、microVM 沙箱与系统化评测框架。"*

**面试重点准备**：
1. 为什么选 pi 而不是 LangChain/CrewAI？（答案：想理解 harness 层最小核心，pi 的 durable session/lanes/deterministic stepping 是最好的教材）
2. MCP 2026-07-28 无状态改了什么？为什么改？
3. ACP vs LSP 的类比；ACP 和 A2A 解决的问题分层
4. Reflexion 论文的 verbal RL 思路，和普通 reflection 的区别
5. SWE-bench 的评测难点在哪（环境准备、patch 验证、oracle tests）
6. 三层记忆为什么这样分？mem0 的 memory decay / 冲突处理怎么做的

**展示素材**（建议在 GitHub README 放）：
- 架构图（pi 核心 + 8 个扩展模块的拓扑）
- MCP 挂载 filesystem server 的 demo gif
- ACP 在 Zed 里调用 pi 的截图
- evals 跑 SWE-bench 的 HTML 报告截图
- 两个 A2A pi 节点对话的 demo 脚本
