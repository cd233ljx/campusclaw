---
summary: "长会话上下文卫生提醒机制的技术实现说明"
read_when:
  - 你需要理解长会话轻提醒的触发策略
  - 你需要为 OpenClaw / Campus Assistant 比赛方案或答辩准备技术说明
  - 你正在调试 contextHygiene 配置、冷却或话题切换判断
title: "Context Hygiene"
---

# Context Hygiene 技术实现说明

Context Hygiene 是给 OpenClaw / Campus Assistant 增加的一层低打扰长会话提醒机制。它的目标不是暴露模型限制，也不是替代已有的压缩能力，而是在会话已经累计较多历史、且用户疑似准备切换到新主题时，用自然中文补充一次轻提示：

- 如果准备开启全新话题，建议使用 `/new` 或 `/clear`
- 如果仍在继续当前任务，保持当前会话即可

它被设计成成熟产品里的“轻提示”，默认低频、可关闭、可演示降级，并且不会打断主回答。

## 设计目标

Context Hygiene 解决的是长会话里的“历史干扰”问题：当用户在一个已经很长的任务会话里突然开始新主题，旧任务、旧工具结果、旧约束可能让回答变得不聚焦。

本机制遵循以下原则：

- 优先使用已有内部能力，例如 preflight compaction、auto compaction、memory flush、session pruning。
- 不直接向用户暴露技术表达，例如“上下文窗口不足”“token 快满”“模型能力下降”。
- 只在长会话且疑似换题时提醒，连续完成同一任务时尽量不提醒。
- 提醒作为附加 payload 追加到主回答之后，不替代回答主体。
- 同一长会话内有冷却机制，避免每轮重复。
- 支持 `demoMode`，便于比赛演示时关闭提醒，保持连续服务观感。

## 现有链路位置

OpenClaw 当前回复链路大致如下：

1. `src/auto-reply/reply/agent-runner.ts` 接收一次用户输入，解析会话、队列、typing、模型和运行配置。
2. `runPreflightCompactionIfNeeded()` 在回复生成前尝试预压缩过长历史。
3. `runMemoryFlushIfNeeded()` 在需要时将重要状态写入长期记忆。
4. `runAgentTurnWithFallback()` 进入模型调用与 fallback 链路。
5. embedded runner 在 `src/agents/pi-embedded-runner/run/attempt.ts` 中执行 history sanitize、replay validate、history limit、context engine assemble、hook 注入、工具装配与 prompt 提交。
6. 回复生成后回到 `agent-runner.ts`，统一组装最终 payload、verbose notice、usage line、trace payload 等。

Context Hygiene 接在第 2、3 步之后，第 4 步之前完成判断，但提醒 payload 会在第 6 步追加到最终回复之后。

这样设计有两个好处：

- 如果内部压缩已经解决问题，默认不提醒用户。
- 提醒不会进入模型 prompt，也不会影响工具调用、回答内容或 transcript 语义。

## 关键实现文件

核心实现位于：

- `src/auto-reply/reply/context-hygiene.ts`

主流程接入位于：

- `src/auto-reply/reply/agent-runner.ts`

配置类型与校验位于：

- `src/config/types.agent-defaults.ts`
- `src/config/zod-schema.agent-defaults.ts`
- `src/config/schema.help.ts`

会话冷却状态位于：

- `src/config/sessions/types.ts`
- `src/auto-reply/reply/session.ts`
- `src/auto-reply/reply/agent-runner-session-reset.ts`

测试位于：

- `src/auto-reply/reply/context-hygiene.test.ts`
- `src/config/config.schema-regressions.test.ts`

## 配置项

配置挂在 `agents.defaults.contextHygiene`：

```json
{
  "agents": {
    "defaults": {
      "contextHygiene": {
        "enabled": true,
        "warnThresholdRatio": 0.8,
        "cooldownTurns": 12,
        "minTurnsBeforeWarn": 16,
        "onlyWhenTopicShift": true,
        "preferInternalSummarization": true,
        "demoMode": false
      }
    }
  }
}
```

字段说明：

| 字段                          | 默认值  | 作用                                             |
| ----------------------------- | ------- | ------------------------------------------------ |
| `enabled`                     | `true`  | 是否启用提醒机制。设为 `false` 后完全不生效。    |
| `warnThresholdRatio`          | `0.8`   | 会话上下文估算占比达到该比例后，才进入提醒候选。 |
| `cooldownTurns`               | `12`    | 触发一次后，多少个用户轮次内不再重复提醒。       |
| `minTurnsBeforeWarn`          | `16`    | 至少累计多少个用户轮次后才允许提醒。             |
| `onlyWhenTopicShift`          | `true`  | 是否仅在疑似换题时提醒。                         |
| `preferInternalSummarization` | `true`  | 如果本轮已执行内部压缩，则不再提醒用户。         |
| `demoMode`                    | `false` | 演示模式。开启后禁用提醒，保证比赛演示连续性。   |

## 触发流程

`evaluateContextHygieneReminder()` 是核心决策函数，判断顺序如下：

1. 配置关闭：直接不提醒。
2. `demoMode=true`：直接不提醒。
3. 本轮已经执行 preflight compaction 且 `preferInternalSummarization=true`：不提醒。
4. 用户轮次少于 `minTurnsBeforeWarn`：不提醒。
5. 会话估算占比低于 `warnThresholdRatio`：不提醒。
6. 仍在冷却期内：不提醒。
7. 如果 `onlyWhenTopicShift=true`，但没有检测到换题：不提醒。
8. 通过以上条件后，返回一条中文提醒模板。

主流程在 `agent-runner.ts` 中读取当前 session transcript，并调用该决策函数。若需要提醒，则把提醒作为一个普通文本 payload 追加到主回答之后。

## 长会话估算策略

系统优先使用现有运行态 token 信息：

1. 如果 `SessionEntry.totalTokens` 是新鲜的，也就是 `totalTokensFresh=true`，优先使用它。
2. 否则使用现有 `estimateMessagesTokens(messages)` 对 transcript message 做近似估算。
3. 如果没有可用 token budget，则降级为字符数估算，按约 `4 chars/token` 的粗略比例换算。

这个策略没有引入新依赖，也不绑定某个模型 tokenizer。局限是估算值不是模型真实 token 数，尤其在中英文混合、工具结果、结构化 content block 较多时会有偏差。因此提醒逻辑还叠加了最小轮次、话题切换和冷却机制，避免单靠估算值触发。

## 话题切换判断

话题切换判断由 `detectContextHygieneTopicShift()` 完成，采用保守工程启发式：

- 提取最近若干用户消息作为“当前任务主题”。
- 提取最新用户输入作为“新问题主题”。
- 对英文、路径、标识符使用简单 token；对中文使用二字片段。
- 计算新旧主题关键词重叠比例。
- 如果出现明显延续标记，例如“继续”“接着”“刚才”“跑测试”“continue”，直接视为同一任务链路。
- 如果出现明显换题标记，例如“换个话题”“新问题”“另一个问题”“new topic”，在重叠较低时视为换题。

默认策略宁可漏提醒，也避免误提醒。原因是产品约束要求低打扰，连续任务中误导用户 `/clear` 的代价更高。

## 冷却机制

冷却状态记录在 `SessionEntry.contextHygieneLastWarnTurn`。

每次触发提醒后，系统记录当前 user turn 数。后续判断时，如果：

```text
当前 user turn - 上次提醒 user turn <= cooldownTurns
```

则不再提醒。

当用户使用 `/new`、`/clear` 或系统重置 session 时，该字段会被清理，避免新会话继承旧冷却状态。

## 提醒文案

提醒模板集中定义在 `CONTEXT_HYGIENE_REMINDER_TEMPLATES`，当前为中文产品化表达，并避免技术术语。

示例：

```text
当前会话内容已经比较多。若你准备开始一个新问题，建议用 /new 或 /clear，这样结果会更聚焦；如果还在继续当前任务，直接接着说就行。
```

禁止表达包括：

- 上下文窗口不足
- token 快满
- 模型降智
- 显存
- 推理能力下降

模板按 user turn 做轮换，避免同一长会话里重复出现完全相同文案。

## 演示模式

`demoMode=true` 时，Context Hygiene 不显示提醒。

这样设计是因为比赛演示更强调：

- 连续服务能力
- 上下文承接能力
- 助理稳定性
- 不打断评委体验

生产环境可以开启提醒，而演示环境可以通过配置一键关闭，做到能力存在但不干扰展示。

## 与 compaction / pruning 的关系

Context Hygiene 不负责压缩历史。它只负责“是否需要给用户一个轻提醒”。

已有能力分工如下：

| 能力                 | 作用                                 | 是否改 transcript |
| -------------------- | ------------------------------------ | ----------------- |
| preflight compaction | 回复前主动压缩长历史                 | 是                |
| auto compaction      | 模型调用中接近或超过限制时压缩并重试 | 是                |
| memory flush         | 压缩前保留重要长期状态               | 是，写入记忆      |
| session pruning      | 裁剪旧工具结果，减少上下文负担       | 否，仅请求内      |
| context hygiene      | 长会话换题时轻提醒用户               | 否                |

因此它是一个产品体验层的补充，而不是上下文管理主机制。

## 测试覆盖

新增测试覆盖以下验收场景：

1. 短会话不提醒。
2. 长会话但仍在同一任务链路，不提醒。
3. 长会话且明显切换新话题，触发提醒。
4. 触发后冷却期内不重复提醒。
5. `demoMode` 开启时不提醒。
6. `enabled=false` 时完全不生效。
7. 本轮已经内部压缩时，优先不提醒。
8. 提醒文案不包含禁止的技术化表达。
9. 配置 schema 接受 `agents.defaults.contextHygiene`。

验证命令：

```bash
pnpm test src/auto-reply/reply/context-hygiene.test.ts src/config/config.schema-regressions.test.ts -t "contextHygiene|context hygiene"
pnpm tsgo --noEmit --pretty false
pnpm exec oxfmt --check src/auto-reply/reply/context-hygiene.ts src/auto-reply/reply/context-hygiene.test.ts src/auto-reply/reply/agent-runner.ts src/auto-reply/reply/agent-runner-session-reset.ts src/auto-reply/reply/session.ts src/config/config.schema-regressions.test.ts src/config/schema.help.ts src/config/sessions/types.ts src/config/types.agent-defaults.ts src/config/zod-schema.agent-defaults.ts
```

## 答辩讲法

可以把这项能力概括为：

> 我们没有把长上下文问题粗暴暴露给用户，而是先利用系统内部的压缩、裁剪和记忆能力消化历史压力。只有在会话已经很长、用户又疑似切换到全新主题时，才用自然中文追加一次轻提示，让用户知道可以新开会话获得更聚焦的结果；如果仍在当前任务里，则无需处理。

这个设计体现了三个产品细节：

- 技术问题产品化表达，不暴露底层限制。
- 优先内部自愈，用户无感优先。
- 可配置、低频、可演示降级，适合真实使用和比赛展示两种场景。
