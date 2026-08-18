# Phase 1：MCP Client + Memory 系统

> 完成日期：2026-08-07
> 代码位置：
> - MCP Client：[packages/coding-agent/examples/extensions/mcp/](../../packages/coding-agent/examples/extensions/mcp/)
> - Memory：[packages/coding-agent/examples/extensions/memory/](../../packages/coding-agent/examples/extensions/memory/)

---

## 模块 1：MCP Client

**目标**：让 pi 能通过官方 SDK 挂载 MCP Server，其 tools/resources/resource templates/prompts 自动注册给 LLM。

**完成状态**：✅ 已完成，约 660 行 glue code。

### 参考实现（不要自己写协议）

| 用途 | 仓库 / 包 |
|---|---|
| 官方 TS SDK（实际固定使用 `@modelcontextprotocol/sdk@1.30.0`） | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| 多 server 管理参考 | VS Code Copilot MCP 接入逻辑（`@modelcontextprotocol/inspector` 可参考 UI 思路） |
| 动态工具注册样例 | pi 自带 [dynamic-tools.ts](../../packages/coding-agent/examples/extensions/dynamic-tools.ts) |

### 实际实现的能力清单

| 能力 | 实现状态 |
|---|---|
| **配置加载** | ✅ 从 `~/.pi/mcp.json`（全局）+ `<cwd>/.pi/mcp.json`（项目级，覆盖全局）读取 `mcpServers` 配置 |
| **Stdio transport** | ✅ 通过 `StdioClientTransport` 启动子进程，支持 `env` 环境变量注入（如 GitHub token） |
| **2026-07-28 无状态协议** | ✅ 使用 `server/discover` 发现能力，无 `initialize` / `Mcp-Session-Id`；每个请求携带协议版本、client info 与 capabilities metadata；HTTP 自动附带 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 标头 |
| **Streamable HTTP transport** | ✅ 通过 `StreamableHTTPClientTransport` 连接远程 MCP server，支持自定义 `headers`（如 Bearer token）；7.28 server 使用每请求 POST/SSE，不再依赖 GET stream 或协议 session |
| **Tools 挂载** | ✅ 每个 MCP tool 以 `mcp__<server>__<tool>` 命名注册到 pi，JSON Schema → TypeBox 用 `Type.Unsafe` 透传 |
| **Resources 挂载** | ✅ 合成一个 `mcp__<server>__read_resource` 工具，description 里列出静态 resources 与 resource templates，LLM 可按需读取 |
| **Prompts 挂载** | ✅ 每个 MCP prompt 注册为 `/mcp-prompt-<server>-<name>` 斜杠命令，支持位置参数和 `key=value` 参数，执行后作为用户消息注入 |
| **分页、缓存与变更通知** | ✅ 沿 cursor 拉取 tools/prompts/resources/templates 全部分页；通过 `subscriptions/listen` 订阅 list_changed。服务端给出 `ttlMs` 时可由客户端作为 freshness hint 使用。消失的 tool 会从 pi active tools 移除，消失的 prompt 会变成明确的 unavailable 命令 |
| **协议边界** | ✅ 仅支持 2026-07-28 无状态 server；不发送 `initialize` 或 `notifications/initialized`，也不接受 `Mcp-Session-Id`、GET stream、旧版 `resources/subscribe` 语义 |
| **生命周期管理** | ✅ `session_start` 时连接所有 server，`session_shutdown` 时关闭所有 transport；状态栏显示连接状态（connecting/N servers/N tools/N prompts） |
| **取消与错误处理** | ✅ 工具/资源调用传递 AbortSignal 与超时；transport 错误抛给 pi，MCP tool 的 `isError=true` 保持为错误结果 |
| **用户命令** | ✅ `/mcp-list`（列出所有 server/tool/prompt/resource）、`/mcp-reload`（重连所有 server） |
| **E2E 测试** | ✅ 用 pi SDK 创建真实会话，加载 2026-07-28 stdio fixture，验证能力发现、工具注册和 `tools/call` 返回内容 |

### 配置示例

```json
{
  "mcpServers": {
    "modern-stdio": {
      "command": "node",
      "args": ["/path/to/2026-07-28-mcp-server.mjs"]
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
mkdir -p your-project/.pi
cp packages/coding-agent/examples/extensions/mcp/mcp.example.json your-project/.pi/mcp.json
# 修改 filesystem server 的路径为你的项目目录

# 启动 pi，加载 MCP 扩展
./pi-test.sh -e packages/coding-agent/examples/extensions/mcp/index.ts
```

### 简历话术

**"基于官方 MCP TypeScript SDK transport 为极简 coding agent harness 实现 MCP 2026-07-28 无状态 client：每请求版本与能力 metadata、`server/discover`、Streamable HTTP 标准 headers、`subscriptions/listen` 动态能力刷新，以及 tools/resources/prompts 热挂载。"**

---

## 模块 2：记忆系统 Memory

**目标**：让 agent 拥有跨会话的长期记忆，能主动记住用户偏好、项目约定、关键决策。

**完成状态**：✅ 已完成 v0.1，约 300 行 glue code。核心记忆逻辑**不自己写**，spawn MCP 2026-07-28 兼容的 Knowledge Graph Memory Server 作为后端。

### 设计原则（非常重要）

**不要自己实现记忆存储/检索/去重/embedding**——这是社区里最容易踩的坑。直接接入成熟开源实现，只写 glue 层：
- 存储格式、JSONL 持久化、节点搜索、图谱 CRUD：**全部交给兼容的 Knowledge Graph MCP server**
- 本 extension 只负责：spawn 子进程 + 转发 MCP 调用 + system prompt 自动注入 + LLM 友好的工具封装 + 用户命令

### 参考实现（实际使用的）

| 层 | 实际选型 | 说明 |
|---|---|---|
| 知识图谱存储/检索后端 | MCP 2026-07-28 兼容的 Knowledge Graph server | 通过 MCP stdio 子进程方式 spawn，entities/relations/observations 三元组模型，内置 `search_nodes`，JSONL 持久化，每次操作后立即写盘 |
| 通信协议 | `@modelcontextprotocol/sdk` Client（和 MCP 扩展复用同一 SDK） | 不引入 mem0 等额外依赖，减少 runtime 复杂度；后续若需要语义向量检索，可再加 mem0-mcp server 通过 MCP 扩展挂载（零代码改动） |
| System prompt 注入参考 | pi 自带 [system-prompt-header.ts](../../packages/coding-agent/examples/extensions/system-prompt-header.ts) | 通过 `before_agent_start` 事件返回 `{systemPrompt: ...}`，pi 负责链式拼接多个扩展的 prompt 段 |

### 实际实现的能力清单

| 能力 | 实现状态 |
|---|---|
| **后端进程管理** | ✅ `session_start` 时从已声明的 workspace 依赖解析并 spawn MCP 2026-07-28 兼容的 memory server，不在运行时联网下载；通过 `MEMORY_FILE_PATH` 指定持久化路径为 `<cwd>/.pi/memory.jsonl`，`session_shutdown` 时关闭 transport |
| **记忆持久化** | ✅ 官方 server 负责 JSONL 存储（每行一个 entity/relation），每次写操作后立即 `fs.writeFile` 刷盘，实测 <500ms 落盘 |
| **工具：memory__add_fact** | ✅ LLM 友好封装：自动判断 entity 是否存在，不存在先 `create_entities`，存在则 `add_observations`，LLM 无需关心底层 API 细节 |
| **工具：memory__search** | ✅ 转发到官方 `search_nodes`（关键词匹配 entity 名称/类型/observations） |
| **工具：memory__read_graph** | ✅ 转发到官方 `read_graph`，返回完整知识图谱 |
| **工具：memory__create_relations** | ✅ 转发到官方 `create_relations`，支持 `User --uses--> Neovim` 这样的有向关系 |
| **工具：memory__forget_entity** | ✅ 转发到官方 `delete_entities`，删除实体及其关联 relations |
| **状态一致性** | ✅ 所有 `memory__*` 工具声明为 sequential，避免支持并行工具调用的模型在同一轮让检索抢跑到写入之前 |
| **自动上下文注入** | ✅ `before_agent_start` 用当前用户提示调用官方 `search_nodes`，只注入相关实体/关系，并设置实体数、observations 数和总字符上限，避免完整图谱随规模线性挤占上下文 |
| **用户命令** | ✅ `/memory`（查看当前图谱）、`/memory-forget`（清空所有记忆，带 confirm 弹窗） |
| **状态栏** | ✅ `session_start` 成功后显示 `Memory KG: <path>` |
| **E2E 测试** | ✅ 创建 pi 会话并写入事实/关系 → 完整关闭扩展与 server → 用同一 cwd 创建全新会话/server → 验证 JSONL 跨进程持久化与检索 → 删除实体 |

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

LLM 会自动发现 `memory__*` 工具，并在相关检索有结果时看到有大小上限的 `## Relevant Long-term Memory` 段；完整图谱只通过显式工具或命令读取。

### 简历话术

**"基于 Anthropic 官方 Knowledge Graph MCP Server 为 coding agent 实现长期记忆系统，通过薄 glue 层（~300 行）spawn 独立 MCP 子进程承载记忆逻辑（实体-关系-观察三元组、JSONL 持久化、关键词检索），利用 before_agent_start 事件自动注入 system prompt，提供 LLM 友好的 add/search/read/relation/forget 工具集，跨会话持久化项目约定与用户偏好。"**
