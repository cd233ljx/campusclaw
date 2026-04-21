import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  CONTEXT_HYGIENE_REMINDER_TEMPLATES,
  detectContextHygieneTopicShift,
  evaluateContextHygieneReminder,
} from "./context-hygiene.js";

function makeHistory(userTurns: number, userText: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < userTurns; index += 1) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `${userText} 第 ${index} 轮` }],
      timestamp: index * 2,
    } as AgentMessage);
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `已处理 ${userText} 第 ${index} 轮` }],
      timestamp: index * 2 + 1,
    } as AgentMessage);
  }
  return messages;
}

function hygieneConfig(
  overrides: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["contextHygiene"] = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        contextHygiene: {
          enabled: true,
          warnThresholdRatio: 0.75,
          cooldownTurns: 8,
          minTurnsBeforeWarn: 6,
          onlyWhenTopicShift: true,
          preferInternalSummarization: true,
          demoMode: false,
          ...overrides,
        },
      },
    },
  };
}

describe("context hygiene reminders", () => {
  it("does not remind in short sessions", () => {
    const decision = evaluateContextHygieneReminder({
      cfg: hygieneConfig(),
      messages: makeHistory(2, "校园课程推荐"),
      prompt: "明天广州天气怎么样",
      sessionEntry: { totalTokens: 900, totalTokensFresh: true },
      contextWindowTokens: 1000,
    });

    expect(decision.shouldWarn).toBe(false);
    expect(decision.reason).toBe("short_session");
  });

  it("does not remind for a long session that is still on the same task chain", () => {
    const decision = evaluateContextHygieneReminder({
      cfg: hygieneConfig(),
      messages: makeHistory(10, "修复 登录 接口 测试 失败"),
      prompt: "继续修复登录接口测试失败，并把相关用例补齐",
      sessionEntry: { totalTokens: 920, totalTokensFresh: true },
      contextWindowTokens: 1000,
    });

    expect(decision.shouldWarn).toBe(false);
    expect(decision.reason).toBe("same_topic");
  });

  it("reminds for a long session with an obvious topic shift", () => {
    const decision = evaluateContextHygieneReminder({
      cfg: hygieneConfig(),
      messages: makeHistory(10, "修复 登录 接口 测试 失败"),
      prompt: "明天广州天气怎么样，适合去天河公园吗",
      sessionEntry: { totalTokens: 920, totalTokensFresh: true },
      contextWindowTokens: 1000,
    });

    expect(decision.shouldWarn).toBe(true);
    expect(decision.reason).toBe("warn");
    expect(decision.reminderText).toContain("/new");
    expect(decision.reminderText).toContain("/clear");
  });

  it("does not repeat during the cooldown window", () => {
    const decision = evaluateContextHygieneReminder({
      cfg: hygieneConfig(),
      messages: makeHistory(10, "修复 登录 接口 测试 失败"),
      prompt: "明天广州天气怎么样，适合去天河公园吗",
      sessionEntry: {
        totalTokens: 920,
        totalTokensFresh: true,
        contextHygieneLastWarnTurn: 9,
      },
      contextWindowTokens: 1000,
    });

    expect(decision.shouldWarn).toBe(false);
    expect(decision.reason).toBe("cooldown");
  });

  it("disables reminders in demo mode", () => {
    const decision = evaluateContextHygieneReminder({
      cfg: hygieneConfig({ demoMode: true }),
      messages: makeHistory(20, "修复 登录 接口 测试 失败"),
      prompt: "换个话题，帮我规划周末广州一日游",
      sessionEntry: { totalTokens: 980, totalTokensFresh: true },
      contextWindowTokens: 1000,
    });

    expect(decision.shouldWarn).toBe(false);
    expect(decision.reason).toBe("demo_mode");
  });

  it("does nothing when disabled in config", () => {
    const decision = evaluateContextHygieneReminder({
      cfg: hygieneConfig({ enabled: false }),
      messages: makeHistory(20, "修复 登录 接口 测试 失败"),
      prompt: "换个话题，帮我规划周末广州一日游",
      sessionEntry: { totalTokens: 980, totalTokensFresh: true },
      contextWindowTokens: 1000,
    });

    expect(decision.shouldWarn).toBe(false);
    expect(decision.reason).toBe("disabled");
  });

  it("suppresses reminders on turns where internal compaction already ran", () => {
    const decision = evaluateContextHygieneReminder({
      cfg: hygieneConfig(),
      messages: makeHistory(20, "修复 登录 接口 测试 失败"),
      prompt: "换个话题，帮我规划周末广州一日游",
      sessionEntry: { totalTokens: 980, totalTokensFresh: true },
      contextWindowTokens: 1000,
      preflightCompactionApplied: true,
    });

    expect(decision.shouldWarn).toBe(false);
    expect(decision.reason).toBe("internal_summarization_preferred");
  });

  it("keeps the topic-shift heuristic conservative for short continuation prompts", () => {
    expect(
      detectContextHygieneTopicShift({
        messages: makeHistory(12, "校园 MCP 登录 Cookie 刷新"),
        prompt: "跑测试",
      }),
    ).toBe(false);
  });

  it("uses product language without banned technical terms", () => {
    const banned = ["上下文窗口", "token", "模型降智", "显存", "推理能力下降"];
    for (const template of CONTEXT_HYGIENE_REMINDER_TEMPLATES) {
      for (const term of banned) {
        expect(template).not.toContain(term);
      }
    }
  });
});
