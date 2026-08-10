# Phase 实施记录

这些文档只记录本项目在 pi 上新增的扩展能力，不修改或重述 pi 上游原始文档。扩展遵循同一个原则：复用成熟项目的 SDK、协议实现和服务端，把 pi 保持为极简 harness；扩展只负责生命周期、事件和工具协议之间的适配。

| Phase | 模块 | 文档 |
|---|---|---|
| Phase 1 | MCP Client + Memory | [phase-1-mcp-memory.md](./phase-1-mcp-memory.md) |
| Phase 2 | ACP + Sandbox | [phase-2-acp-sandbox.md](./phase-2-acp-sandbox.md) |
| Phase 3 | Planning/Reflection + Evals | [phase-3-plan-reflect-evals.md](./phase-3-plan-reflect-evals.md) |
| Phase 4 | A2A 双向适配 | [phase-4-a2a.md](./phase-4-a2a.md) |
| Phase 5 | Agent Economy 实验层 | [phase-5-agent-economy.md](./phase-5-agent-economy.md) |
| Phase 6 | Agent Loop + Agent Graph | [phase-6-agent-loop-graph.md](./phase-6-agent-loop-graph.md) |

## 自动验证

先在 `pi-main/` 安装工作区依赖，然后运行：

```bash
npm install
node docs/scripts/verify-all.mjs
```

也可以只验证指定阶段：

```bash
node docs/scripts/verify-all.mjs 1 2
node docs/scripts/verify-all.mjs 4 5
```

不传阶段时会先执行全项目 TypeScript 检查，再执行 10 组无需模型凭据的真实测试：MCP、Memory、ACP、Sandbox、Plan/Reflect、Evals 框架、A2A、Economy、Agent Loop 和 Agent Graph。依赖缺失或测试失败都会返回非零退出码，不会静默跳过。

若同时设置 `PI_PROVIDER` 和 `PI_MODEL`，脚本还会运行额外一组模型评测，让真实 AgentSession 编写 `sum.js` 并执行测试；未设置时会明确打印跳过，不会把框架单测冒充模型能力验证。

构建后还可以运行真实模型集成矩阵。它不是只检查模型能否回复文本，而是断言模型实际产生对应工具调用、协议消息和工作流状态：

```bash
npm run build:offline
PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-pro node docs/scripts/verify-live-model.mjs
```

当前 live matrix 覆盖 MCP、Memory、Sandbox、Plan/Reflect、Economy、ACP、A2A、Agent Loop 和 Agent Graph。测试使用临时工作区和临时 Economy home，不把测试记忆、身份或图定义写入项目。

## 手动验证入口

加载对应扩展后，可用以下命令观察运行状态：

| 模块 | 命令 |
|---|---|
| MCP | `/mcp-list`、`/mcp-reload` |
| Memory | `/memory`、`/memory-forget` |
| Planning/Reflection | `/plan auto\|on\|off`、`/reflect on\|off`、`/think` |
| Sandbox | `/sandbox status`、`/sandbox test`、`/sandbox log 20` |
| A2A | `/a2a start 41241`、`/a2a discover <url>`、`/a2a stop` |
| Economy | `/did show`、`/wallet balance`、`/mcp-search <词>`、`/a2a-register <url>`、`/a2a-list`、`/economy` |
| Agent Loop | `/agent-loop start <目标>`、`/agent-loop status`、`/agent-loop pause`、`/agent-loop resume`、`/agent-loop stop` |
| Agent Graph | `/agent-graph list`、`/agent-graph show <名称>`、`/agent-graph validate <名称>`、`/agent-graph run <名称> <输入>` |

Sandbox 的运行模式由 `PI_SANDBOX_MODE=on|audit-only|off` 配置，不由斜杠命令切换。Economy 的钱包和 AP2 风格结算是本地模拟能力，不代表真实支付网络集成；`ap2_pay` 在交互会话中必须经过 UI 确认后才会修改余额。

## 能力边界

- MCP、Memory、ACP、A2A 使用声明并锁定版本的上游 SDK/服务，不复制上游协议核心。
- Planning/Reflection 是 pi 事件钩子上的策略层；它能阻止重复失败的工具调用，但不是通用工作流引擎。
- Sandbox 在支持的平台使用 `@anthropic-ai/sandbox-runtime`；默认 `auto` 在后端不可用时明确降级为 audit-only，而显式 `PI_SANDBOX_MODE=on` 会 fail-closed、拒绝执行，并始终保留致命命令过滤。
- Economy 提供可验证的 DID:key/Ed25519 签名、本地报价和确认式模拟支付；真实 AP2 支付轨道、VC 和远程信任体系仍不在 v0.1 范围内。
- Agent Loop 参考 ADK 的确定性循环控制，但保留 pi 的完整 AgentSession；它由显式 checkpoint 和硬预算约束，不自动跨重启执行。
- Agent Graph 直接使用 LangGraph.js StateGraph；当前 JSON 适配层支持单路条件分支和循环，尚未开放并行 fan-out/fan-in 或持久化中途恢复。
