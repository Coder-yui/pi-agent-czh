# Phase 1：MCP Client + Memory 系统

> 完成日期：2026-08-07
> 代码位置：
> - MCP Client：[packages/coding-agent/examples/extensions/mcp/](../../packages/coding-agent/examples/extensions/mcp/)
> - Memory：[packages/coding-agent/examples/extensions/memory/](../../packages/coding-agent/examples/extensions/memory/)

---

## 模块 1：MCP Client

**目标**：让 pi 能挂载任意 MCP 2026-07-28（无状态）Server，其 tools/resources/prompts 自动注册给 LLM。

**完成状态**：✅ 已完成，约 660 行 glue code。

### 参考实现（不要自己写协议）

| 用途 | 仓库 / 包 |
|---|---|
| 官方 TS SDK（实际使用 `@modelcontextprotocol/sdk@^1.30.0`，v2 在开发中未发布） | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) |
| 多 server 管理参考 | VS Code Copilot MCP 接入逻辑（`@modelcontextprotocol/inspector` 可参考 UI 思路） |
| 动态工具注册样例 | pi 自带 [dynamic-tools.ts](../../packages/coding-agent/examples/extensions/dynamic-tools.ts) |

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
| **E2E 测试** | ✅ 用 pi SDK 创建真实会话，加载扩展，挂载 `@modelcontextprotocol/server-filesystem`，验证工具注册 + `list_directory` 真实调用返回目录内容 |

### 配置示例

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
mkdir -p your-project/.pi
cp packages/coding-agent/examples/extensions/mcp/mcp.example.json your-project/.pi/mcp.json
# 修改 filesystem server 的路径为你的项目目录

# 启动 pi，加载 MCP 扩展
./pi-test.sh -e packages/coding-agent/examples/extensions/mcp/index.ts
```

### 简历话术

**"基于官方 MCP TypeScript SDK 为极简 coding agent harness 实现多 server 工具/资源/提示词热挂载，支持 stdio 与 Streamable HTTP 双 transport，自动响应 list_changed 通知刷新能力集，以 extension 形式零侵入核心接入，覆盖官方 filesystem/github 等 15+ 个 server 工具真实调用验证。"**

---

## 模块 2：记忆系统 Memory

**目标**：让 agent 拥有跨会话的长期记忆，能主动记住用户偏好、项目约定、关键决策。

**完成状态**：✅ 已完成 v0.1，约 300 行 glue code。核心记忆逻辑**不自己写**，spawn 官方 `@modelcontextprotocol/server-memory`（Anthropic 官方 Knowledge Graph Memory Server）作为后端。

### 设计原则（非常重要）

**不要自己实现记忆存储/检索/去重/embedding**——这是社区里最容易踩的坑。直接接入成熟开源实现，只写 glue 层：
- 存储格式、JSONL 持久化、节点搜索、图谱 CRUD：**全部交给官方 `@modelcontextprotocol/server-memory`**
- 本 extension 只负责：spawn 子进程 + 转发 MCP 调用 + system prompt 自动注入 + LLM 友好的工具封装 + 用户命令

### 参考实现（实际使用的）

| 层 | 实际选型 | 说明 |
|---|---|---|
| 知识图谱存储/检索后端 | [`@modelcontextprotocol/server-memory`](https://www.npmjs.com/package/@modelcontextprotocol/server-memory)（Anthropic 官方） | 通过 MCP stdio 子进程方式 spawn，entities/relations/observations 三元组模型，内置 `search_nodes`，JSONL 持久化，每次操作后立即写盘 |
| 通信协议 | `@modelcontextprotocol/sdk` Client（和 MCP 扩展复用同一 SDK） | 不引入 mem0 等额外依赖，减少 runtime 复杂度；后续若需要语义向量检索，可再加 mem0-mcp server 通过 MCP 扩展挂载（零代码改动） |
| System prompt 注入参考 | pi 自带 [system-prompt-header.ts](../../packages/coding-agent/examples/extensions/system-prompt-header.ts) | 通过 `before_agent_start` 事件返回 `{systemPrompt: ...}`，pi 负责链式拼接多个扩展的 prompt 段 |

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
| **E2E 测试** | ✅ 创建 pi 会话 → spawn memory server → add 4 条 facts → read_graph 验证 → search 验证 → create_relations 验证 → JSONL 持久化验证 → forget_entity 验证 |

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
