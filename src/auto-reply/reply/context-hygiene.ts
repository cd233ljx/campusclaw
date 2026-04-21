import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentContextHygieneConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

const DEFAULT_WARN_THRESHOLD_RATIO = 0.8;
const DEFAULT_COOLDOWN_TURNS = 12;
const DEFAULT_MIN_TURNS_BEFORE_WARN = 16;
const DEFAULT_ONLY_WHEN_TOPIC_SHIFT = true;
const DEFAULT_PREFER_INTERNAL_SUMMARIZATION = true;
const MIN_TOKEN_BUDGET_FOR_RATIO = 1;
const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_FALLBACK_CONTEXT_CHARS = 200_000;
const RECENT_TOPIC_USER_MESSAGES = 8;
const TOKEN_OVERLAP_CONTINUATION_RATIO = 0.18;
const TOKEN_OVERLAP_SHIFT_RATIO = 0.08;
const MIN_TOPIC_TOKENS = 4;

export const CONTEXT_HYGIENE_REMINDER_TEMPLATES = [
  "当前会话内容已经比较多。若你准备开始一个新问题，建议用 /new 或 /clear，这样结果会更聚焦；如果还在继续当前任务，直接接着说就行。",
  "这段对话累计了较多历史信息。如果接下来想聊全新的事情，建议新开一轮；如果还在继续当前任务，保持当前会话即可。",
  "当前会话已包含不少上下文。若要切换到新主题，建议用 /new 或 /clear，避免旧内容干扰；继续当前任务则不用处理。",
  "如果你接下来要开启一个全新话题，可以用 /new 或 /clear 让回答更聚焦；当前任务还没结束的话，继续在这里说就好。",
] as const;

const CONTINUATION_MARKERS = [
  "继续",
  "接着",
  "刚才",
  "上面",
  "前面",
  "这个",
  "这些",
  "它",
  "当前任务",
  "原来的",
  "继续做",
  "修一下",
  "跑测试",
  "run tests",
  "keep going",
  "continue",
] as const;

const EXPLICIT_SHIFT_MARKERS = [
  "换个话题",
  "新问题",
  "另一个问题",
  "另外问",
  "再问个",
  "不聊这个",
  "现在聊",
  "unrelated",
  "new topic",
] as const;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "when",
  "where",
  "how",
  "please",
  "帮我",
  "一下",
  "这个",
  "那个",
  "可以",
  "请问",
  "我们",
  "你能",
]);

export type ContextHygieneDecision = {
  shouldWarn: boolean;
  reason:
    | "disabled"
    | "demo_mode"
    | "internal_summarization_preferred"
    | "short_session"
    | "below_threshold"
    | "cooldown"
    | "same_topic"
    | "warn";
  reminderText?: string;
  turnCount: number;
  estimatedRatio?: number;
  topicShift?: boolean;
};

export type ContextHygieneResolvedConfig = Required<AgentContextHygieneConfig>;

export function resolveContextHygieneConfig(cfg?: OpenClawConfig): ContextHygieneResolvedConfig {
  const configured = cfg?.agents?.defaults?.contextHygiene;
  return {
    enabled: configured?.enabled ?? true,
    warnThresholdRatio: clampRatio(configured?.warnThresholdRatio, DEFAULT_WARN_THRESHOLD_RATIO),
    cooldownTurns: normalizeNonNegativeInt(configured?.cooldownTurns, DEFAULT_COOLDOWN_TURNS),
    minTurnsBeforeWarn: normalizeNonNegativeInt(
      configured?.minTurnsBeforeWarn,
      DEFAULT_MIN_TURNS_BEFORE_WARN,
    ),
    onlyWhenTopicShift: configured?.onlyWhenTopicShift ?? DEFAULT_ONLY_WHEN_TOPIC_SHIFT,
    preferInternalSummarization:
      configured?.preferInternalSummarization ?? DEFAULT_PREFER_INTERNAL_SUMMARIZATION,
    demoMode: configured?.demoMode ?? false,
  };
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(0.99, Math.max(0.1, value));
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const typed = block as { type?: unknown; text?: unknown };
      return typeof typed.text === "string" ? [typed.text] : [];
    })
    .join("\n");
}

function countUserTurns(messages: AgentMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function estimatePromptTokens(prompt: string): number {
  const text = normalizeOptionalString(prompt);
  if (!text) {
    return 0;
  }
  return Math.ceil(
    estimateMessagesTokens([
      {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      } as AgentMessage,
    ]),
  );
}

function estimateHistoryTokens(params: {
  messages: AgentMessage[];
  sessionEntry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">;
}): { tokens?: number; source: "session" | "messages" | "none" } {
  const persisted = params.sessionEntry?.totalTokens;
  if (
    params.sessionEntry?.totalTokensFresh === true &&
    typeof persisted === "number" &&
    Number.isFinite(persisted) &&
    persisted > 0
  ) {
    return { tokens: Math.ceil(persisted), source: "session" };
  }
  if (params.messages.length === 0) {
    return { source: "none" };
  }
  const estimated = estimateMessagesTokens(params.messages);
  return Number.isFinite(estimated) && estimated > 0
    ? { tokens: Math.ceil(estimated), source: "messages" }
    : { source: "none" };
}

function estimateTextChars(messages: AgentMessage[], prompt: string): number {
  return (
    prompt.length + messages.reduce((sum, message) => sum + extractMessageText(message).length, 0)
  );
}

function estimateContextRatio(params: {
  messages: AgentMessage[];
  prompt: string;
  sessionEntry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">;
  contextWindowTokens?: number;
}): number | undefined {
  const budget =
    typeof params.contextWindowTokens === "number" &&
    Number.isFinite(params.contextWindowTokens) &&
    params.contextWindowTokens > 0
      ? Math.floor(params.contextWindowTokens)
      : undefined;
  const history = estimateHistoryTokens({
    messages: params.messages,
    sessionEntry: params.sessionEntry,
  });
  if (budget && history.tokens) {
    const projectedTokens = history.tokens + estimatePromptTokens(params.prompt);
    return projectedTokens / Math.max(MIN_TOKEN_BUDGET_FOR_RATIO, budget);
  }

  const chars = estimateTextChars(params.messages, params.prompt);
  if (chars <= 0) {
    return undefined;
  }
  const fallbackChars = budget
    ? Math.max(1, budget * APPROX_CHARS_PER_TOKEN)
    : DEFAULT_FALLBACK_CONTEXT_CHARS;
  return chars / fallbackChars;
}

function normalizeForMarkerSearch(text: string): string {
  return text.trim().toLowerCase();
}

function hasAnyMarker(text: string, markers: readonly string[]): boolean {
  const normalized = normalizeForMarkerSearch(text);
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function tokenizeTopic(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9_./:-]{2,}/g)) {
    const value = match[0];
    if (!STOPWORDS.has(value)) {
      tokens.add(value);
    }
  }
  const cjkRuns = normalized.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const gram = run.slice(index, index + 2);
      if (!STOPWORDS.has(gram)) {
        tokens.add(gram);
      }
    }
  }
  return tokens;
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  const denominator = Math.min(a.size, b.size);
  if (denominator <= 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) {
      overlap += 1;
    }
  }
  return overlap / denominator;
}

export function detectContextHygieneTopicShift(params: {
  messages: AgentMessage[];
  prompt: string;
}): boolean {
  const prompt = normalizeOptionalString(params.prompt) ?? "";
  if (!prompt || hasAnyMarker(prompt, CONTINUATION_MARKERS)) {
    return false;
  }
  const currentTokens = tokenizeTopic(prompt);
  if (currentTokens.size < MIN_TOPIC_TOKENS && !hasAnyMarker(prompt, EXPLICIT_SHIFT_MARKERS)) {
    return false;
  }

  const priorUserText = params.messages
    .filter((message) => message.role === "user")
    .slice(-RECENT_TOPIC_USER_MESSAGES)
    .map(extractMessageText)
    .filter(Boolean)
    .join("\n");
  const priorTokens = tokenizeTopic(priorUserText);
  if (priorTokens.size < MIN_TOPIC_TOKENS) {
    return false;
  }

  const ratio = overlapRatio(currentTokens, priorTokens);
  if (ratio >= TOKEN_OVERLAP_CONTINUATION_RATIO) {
    return false;
  }
  if (hasAnyMarker(prompt, EXPLICIT_SHIFT_MARKERS)) {
    return true;
  }
  return ratio <= TOKEN_OVERLAP_SHIFT_RATIO && currentTokens.size >= MIN_TOPIC_TOKENS;
}

function pickReminder(turnCount: number): string {
  const index = Math.abs(Math.floor(turnCount)) % CONTEXT_HYGIENE_REMINDER_TEMPLATES.length;
  return CONTEXT_HYGIENE_REMINDER_TEMPLATES[index];
}

export function evaluateContextHygieneReminder(params: {
  cfg?: OpenClawConfig;
  messages: AgentMessage[];
  prompt: string;
  sessionEntry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "contextHygieneLastWarnTurn"
  >;
  contextWindowTokens?: number;
  preflightCompactionApplied?: boolean;
}): ContextHygieneDecision {
  const config = resolveContextHygieneConfig(params.cfg);
  const turnCount = countUserTurns(params.messages) + 1;
  if (!config.enabled) {
    return { shouldWarn: false, reason: "disabled", turnCount };
  }
  if (config.demoMode) {
    // Competition demos prize uninterrupted continuity; this mode keeps the
    // hygiene feature available in config without surfacing product notices.
    return { shouldWarn: false, reason: "demo_mode", turnCount };
  }
  if (config.preferInternalSummarization && params.preflightCompactionApplied) {
    return { shouldWarn: false, reason: "internal_summarization_preferred", turnCount };
  }
  if (turnCount < config.minTurnsBeforeWarn) {
    return { shouldWarn: false, reason: "short_session", turnCount };
  }

  const ratio = estimateContextRatio({
    messages: params.messages,
    prompt: params.prompt,
    sessionEntry: params.sessionEntry,
    contextWindowTokens: params.contextWindowTokens,
  });
  if (typeof ratio !== "number" || ratio < config.warnThresholdRatio) {
    return { shouldWarn: false, reason: "below_threshold", turnCount, estimatedRatio: ratio };
  }

  const lastWarnTurn = params.sessionEntry?.contextHygieneLastWarnTurn;
  if (
    typeof lastWarnTurn === "number" &&
    Number.isFinite(lastWarnTurn) &&
    turnCount - Math.floor(lastWarnTurn) <= config.cooldownTurns
  ) {
    return { shouldWarn: false, reason: "cooldown", turnCount, estimatedRatio: ratio };
  }

  const topicShift = detectContextHygieneTopicShift({
    messages: params.messages,
    prompt: params.prompt,
  });
  if (config.onlyWhenTopicShift && !topicShift) {
    return {
      shouldWarn: false,
      reason: "same_topic",
      turnCount,
      estimatedRatio: ratio,
      topicShift,
    };
  }

  return {
    shouldWarn: true,
    reason: "warn",
    reminderText: pickReminder(turnCount),
    turnCount,
    estimatedRatio: ratio,
    topicShift,
  };
}
