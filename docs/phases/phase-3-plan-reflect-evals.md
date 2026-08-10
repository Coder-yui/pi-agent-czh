# Phase 3：Planning & Reflection + Agentic Evaluation Framework

> 完成日期：2026-08-07
> 代码位置：
> - Planning & Reflection：[packages/coding-agent/examples/extensions/plan-reflect/](../../packages/coding-agent/examples/extensions/plan-reflect/)
> - Evals 框架：[packages/evals/](../../packages/evals/)（pi 官方内置，补充了 coding-tasks.eval.ts）

---

## 模块 5：Planning & Reflection

**目标**：让 agent 在复杂任务前显式建计划、工具失败时触发反思、避免盲目重试死循环。

**完成状态**：✅ 已完成 v0.1，约 460 行。

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
- 每个工具调用使用工具名 + 完整、稳定序列化后的输入生成 SHA-256 身份键；展示文本仍保持简短，但相同前缀的长命令、同文件的不同 edit 不会被误判为同一次重试
- 默认同一目标最多重试 2 次（可配置）
- 超过限制时注入**强停止信号**：
  ```
  [REFLECTION — RETRY LIMIT REACHED (attempt 3/2)]
  STOP retrying this exact approach. You must:
  1. Re-read the relevant files/surrounding context to understand the root cause
  2. Try a fundamentally different strategy
  3. If stuck, explain what you tried and ask the user for help
  ```
- 成功时自动清除该调用的重试计数；每个新用户 turn 也会清空上一轮失败计数，重启会话不恢复短期 retry 状态

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
| 按完整工具输入的稳定 SHA-256 键独立计数 | ✅ |
| 熔断机制（超过 maxRetries 强制换策略） | ✅ |
| 成功后自动清除重试计数 | ✅ |
| 斜杠命令：/plan [auto\|on\|off]、/reflect [on\|off]、/think | ✅ |
| CLI flags：--plan、--no-reflect | ✅ |
| 状态栏显示：📝 plan:xxx 🔍 reflect 🔄 retries:N | ✅ |
| 配置、统计与当前计划持久化；短期 retry 状态不跨会话恢复 | ✅ |
| e2e 测试：56 项断言全部通过 | ✅ |

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

### E2E 测试覆盖（56 项）

| 测试组 | 断言数 | 覆盖内容 |
|---|---|---|
| 模块加载 | 6 | 导出函数存在、默认配置正确 |
| shouldPlanFor | 16 | off/on/auto 三模式、短提示过滤、8 类英文关键词、3 类中文关键词、长文本触发、只读探索不触发 |
| retry identity | 12 | 工具目标展示、长命令同前缀区分、同文件不同 edit 区分、对象键序稳定 |
| isMeaningfulError | 14 | 成功结果、空内容、12 类错误关键词、"0 errors" 否定语境排除、edit 工具错误 |
| 真实扩展集成 | 6 | 命令切换、两次失败后的确定性阻断、新用户 turn 清理、持久化 |
| TS 动态加载 | 2 | tsx 加载扩展无错误 |

### 简历话术

**"基于 Reflexion (NeurIPS 2023) 和 ReAct 论文实现 Planning-Reflection 认知闭环：在任务开始前通过隐藏 system prompt 注入计划引导（中英文双语智能触发），在工具执行失败时通过 tool_result 钩子以 verbal reinforcement 方式注入反思提示，强制模型在重试前诊断根因而非盲目重试；同时按完整工具输入的稳定哈希维护 turn 内重试计数与熔断机制（默认 2 次），超过阈值在 tool_call 阶段确定性阻断相同失败调用。配置、统计和当前计划通过 session tree 持久化，短期失败计数不会污染新 turn 或重启后的会话。"**

---

## 模块 6：Agentic Evaluation Framework

**目标**：系统性评估 pi agent 能力，跑 benchmark 出分数/报告，形成"造 agent 也会测 agent"的完整闭环。

**完成状态**：✅ pi 官方已有完整生产级框架（基于 `vitest-evals@0.15.0`）；补充了 `coding-tasks.eval.ts` 样例展示如何评测实际代码编写任务。

### 意外发现：pi 官方已实现

调研时发现 pi 官方已经在 monorepo 里预置了完整的 `@earendil-works/pi-evals` 包，根 package.json 也已配置好 `npm run eval` 脚本。不需要从零搭建，直接复用即可——完美符合"能参考实现就参考实现"原则。

### 官方框架能力

| 能力 | 实现 |
|---|---|
| **核心架构** | 基于 Sentry 开源的 [`vitest-evals`](https://github.com/getsentry/vitest-evals)，三段式 Harness/Input/Output + Judge 评分模型 |
| **Pi Harness** | 每次 run 创建隔离临时目录（cwd + agentDir），启动真实 `AgentSession`，结束后自动清理 |
| **Artifact 记录** | 自动快照 native Pi session JSONL 到 `.eval/sessions/<runId>.jsonl`，完整轨迹可回放 |
| **Transcript 事件** | 自动把 messages 转为标准化 transcript events（user_message / assistant_message / tool_call / tool_result 含 error） |
| **Usage 统计** | 自动记录 provider/model、inputTokens、outputTokens、totalTokens、toolCalls、cacheRead/Write、estimatedCostUsd |
| **Timing** | 每个 run 记录 totalMs 耗时 |
| **Judge 评分器** | `createJudge()` 定义评分函数，输出 score (0-1) + metadata（rationale 等） |
| **Harness 对比** | `evalHarnessTable` —— baseline vs candidate 多模型/多配置 A/B 测试，自动计算 pass-rate lift |
| **Reporter** | 自定义 vitest reporter 输出评分汇总 + lift 对比 |
| **Summary** | 测试结束后打印 Markdown 格式 summary 表 |
| **多步 prompt** | 支持 `[{type:"prompt", content}, {type:"reload"}, {type:"prompt", content}]` 序列（创建文件→reload→再 prompt 的场景） |
| **System Prompt 变换** | `transformSystemPrompt` 选项可修改默认系统提示词，方便做 prompt ablation |
| **Model 选择** | 每个 harness 可指定 model `{provider, id}` 覆盖 CLI 默认，便于同任务跑多模型对比 |

### 补充的 eval 样例：coding-tasks.eval.ts

官方已有 smoke.eval.ts（事实问答）和 extensions.eval.ts（扩展编写）两个样例，补充了：

**代码编写任务的 eval 模板**：

1. **任务**：在隔离临时 workspace 里让 agent 写一个 `sum.js` CommonJS 模块，导出 `sum(a,b)` 函数
2. **真实验证**：agent 结束后，eval 端用 `execFileSync` 直接在 Node.js 里 require 产出的文件，跑 4 个测试用例 (2+3=5, -1+1=0, 0+0=0, 100+200=300)
3. **Judge 评分**：SumTaskJudge 检查文件存在 + 所有测试通过，0/1 二元评分，失败时 metadata 记录具体哪个 case 错了
4. **可对比扩展**：代码里预留了 `evalHarnessTable` 用法注释，可快速做 baseline vs with-plan-reflect 的 ablation 研究

这是"hello world eval"：写函数→跑测试→判对错，框架骨架已就位，后续接 SWE-bench/τ-bench 都是按这个模式扩展。

### 运行方式

```bash
# 跑所有模型 eval（需要设置 provider + model）
cd pi-main
PI_PROVIDER=anthropic PI_MODEL=claude-sonnet-4 npm run eval

# 只跑某一个 eval 文件
npm run eval -- src/coding-tasks.eval.ts

# 跑框架单元测试（不需要 LLM；不能证明模型完成了任务）
cd packages/evals && npm test
```

### 现有 eval 清单

| 文件 | 评测内容 |
|---|---|
| smoke.eval.ts | 基础事实问答（capital of France → Paris），验证端到端通路 |
| extensions.eval.ts | 扩展编写能力（创建 hello 工具→reload→调用），对比有/无 pi-docs system prompt 的差异（baseline vs candidate A/B） |
| coding-tasks.eval.ts | 代码编写能力（写 sum.js 并跑 Node.js 测试验证） |

### 后续扩展方向（v0.2+）

v0.1 已验证框架通路通畅，后续可按路线图继续：
1. τ-bench retail 子集接入（工具调用/多轮对话，无需 Docker）
2. SWE-bench Lite 接入（需要 Docker harness，参考 SWE-agent）
3. Regression suite：把前 5 个模块发现的 bug 变成 eval case 持续回归
4. HTML 报告（复用 coding-agent 的 export-html）
5. 并行执行 + trials 重复（多次采样减小方差）

### 简历话术

**"基于 vitest-evals 构建 agentic 评测框架，在独立临时工作目录中启动真实 AgentSession 隔离执行，自动记录 tokens/成本/延迟与完整轨迹 JSONL artifact；实现 Harness/Judge/Transcript 架构与多 harness A/B 对比。框架单测不依赖模型；配置 `PI_PROVIDER`/`PI_MODEL` 后，代码任务会让真实模型生成文件并由 Node.js 子进程执行测试判定。"**
