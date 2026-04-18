import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { buildFeishuCardButton, buildFeishuCardInteractionContext } from "./card-ux-shared.js";
import { isRecord } from "./comment-shared.js";
import { uploadImageFeishu } from "./media.js";
import { sendCardFeishu, sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";

const DEFAULT_START_PATH = "/channel/feishu/jwxt/login/start";
const DEFAULT_SUBMIT_PATH = "/channel/feishu/jwxt/login/submit";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CARD_TTL_MS = 10 * 60_000;
const DEFAULT_TOOL_NAME = "jwxt.get_grades";

const DEFAULT_KEYWORDS = [
  "成绩",
  "绩点",
  "分数",
  "课表",
  "教务",
  "查分",
  "挂科",
  "补考",
  "考试",
  "gpa",
];

const SCHEDULE_HINT = /(课表|课程安排|排课|上课)/;
const SECOND_CLASS_HINT = /(第二课堂|素拓|成长记录|综测)/;
const AMBIGUOUS_CREDIT_HINT = /(学分|毕业|进度|培养方案|credit)/i;
const JWXT_STRONG_SIGNAL_HINT =
  /(教务|成绩单|查分|成绩|分数|绩点|gpa|平均分|均分|挂科|补考|课表|课程安排|排课|上课|考试|schedule|grade|jwxt)/i;
const COURSE_RECOMMENDATION_HINT =
  /((推荐|安利|建议).{0,8}(课程|选修|公选|通识|体育课?|课)|((课程|选修|公选|通识|体育课?|课).{0,8}(推荐|安利|建议)))/;
const JWXT_ACTION_VERB_HINT = /(查|看|查询|获取|显示|帮我查|帮我看|看看|show|get|check)/i;
const JWXT_DOMAIN_HINT =
  /(教务|成绩单|查分|成绩|分数|绩点|gpa|平均分|均分|挂科|补考|课表|课程安排|排课|上课|考试|schedule|grade|jwxt)/i;
const JWXT_FALLBACK_INTENT_HINT =
  /(教务|成绩单|查分|成绩|分数|绩点|gpa|平均分|均分|挂科|补考|课表|课程安排|上课|排课|考试|schedule|grade|jwxt)/i;

export const FEISHU_JWXT_LOGIN_SUBMIT_ACTION = "feishu.jwxt.login.submit";
export const FEISHU_JWXT_LOGIN_SUBMIT_BUTTON_NAME = "jwxt_login_submit";

const JWXT_SUBMIT_METADATA_CACHE_TTL_MS = 20 * 60_000;
const JWXT_SUBMIT_METADATA_CACHE_LIMIT = 256;

type FeishuJwxtSubmitEnvelopeMetadata = {
  login_ticket: string;
  user_id?: string;
  channel?: string;
  tenant_key?: string;
  expires_at_ms: number;
};

const feishuJwxtSubmitMetadataCache = new Map<string, FeishuJwxtSubmitEnvelopeMetadata>();

type FeishuCardChatType = "p2p" | "group";

type FeishuJwxtLoginFlowRuntimeConfig = {
  enabled: boolean;
  baseUrl: string;
  startPath: string;
  submitPath: string;
  tenantKey: string;
  authHeader?: string;
  authHeaderName: string;
  keywordPatterns: string[];
  defaultToolName: string;
  timeoutMs: number;
};

type JwxtLoginCardPayload = {
  title: string;
  description: string;
  captchaImageBase64: string;
  hidden: {
    loginTicket: string;
    userId?: string;
    channel?: string;
    tenantKey?: string;
  };
  submitLabel: string;
  expireAtMs: number;
};

type JwxtStartResponse = {
  success?: boolean;
  need_login?: boolean;
  user_message?: string;
  replay_result?: unknown;
  card_payload?: unknown;
};

type JwxtSubmitResponse = {
  success?: boolean;
  user_message?: string;
  replay_result?: unknown;
  card_payload?: unknown;
};

type JwxtIntent = {
  hasIntent: boolean;
  toolName: string;
};

type JwxtRequestResult = {
  status: number;
  body: unknown;
};

function normalizeChatIdForSubmitMetadata(chatId: string): string {
  const normalized = chatId.trim();
  if (normalized.startsWith("chat:")) {
    return normalized.slice("chat:".length).trim();
  }
  return normalized;
}

function buildSubmitMetadataCacheKey(params: {
  accountId?: string;
  operatorOpenId: string;
  chatId: string;
}): string {
  const accountKey = (params.accountId ?? "default").trim() || "default";
  const openId = params.operatorOpenId.trim();
  const chatId = normalizeChatIdForSubmitMetadata(params.chatId);
  return `${accountKey}:${openId}:${chatId}`;
}

function pruneSubmitMetadataCache(now: number): void {
  for (const [key, entry] of feishuJwxtSubmitMetadataCache.entries()) {
    if (entry.expires_at_ms <= now) {
      feishuJwxtSubmitMetadataCache.delete(key);
    }
  }
  if (feishuJwxtSubmitMetadataCache.size <= JWXT_SUBMIT_METADATA_CACHE_LIMIT) {
    return;
  }
  const sorted = [...feishuJwxtSubmitMetadataCache.entries()].toSorted(
    (a, b) => a[1].expires_at_ms - b[1].expires_at_ms,
  );
  const overflow = feishuJwxtSubmitMetadataCache.size - JWXT_SUBMIT_METADATA_CACHE_LIMIT;
  for (let index = 0; index < overflow; index += 1) {
    const key = sorted[index]?.[0];
    if (key) {
      feishuJwxtSubmitMetadataCache.delete(key);
    }
  }
}

function cacheFeishuJwxtSubmitEnvelopeMetadata(params: {
  accountId?: string;
  operatorOpenId: string;
  chatId: string;
  metadata: Record<string, unknown>;
  expiresAtMs: number;
}): void {
  const loginTicket = trimString(params.metadata.login_ticket);
  if (!loginTicket) {
    return;
  }

  const now = Date.now();
  const expiresAtMs = Math.max(params.expiresAtMs, now + 5_000);
  const key = buildSubmitMetadataCacheKey({
    accountId: params.accountId,
    operatorOpenId: params.operatorOpenId,
    chatId: params.chatId,
  });

  feishuJwxtSubmitMetadataCache.set(key, {
    login_ticket: loginTicket,
    user_id: trimString(params.metadata.user_id),
    channel: trimString(params.metadata.channel),
    tenant_key: trimString(params.metadata.tenant_key),
    expires_at_ms: Math.min(expiresAtMs, now + JWXT_SUBMIT_METADATA_CACHE_TTL_MS),
  });

  pruneSubmitMetadataCache(now);
}

export function resolveFeishuJwxtLoginSubmitMetadataFallback(params: {
  accountId?: string;
  operatorOpenId: string;
  chatId: string;
}): Record<string, unknown> | undefined {
  const now = Date.now();
  pruneSubmitMetadataCache(now);

  const key = buildSubmitMetadataCacheKey(params);
  const metadata = feishuJwxtSubmitMetadataCache.get(key);
  if (!metadata || metadata.expires_at_ms <= now) {
    feishuJwxtSubmitMetadataCache.delete(key);
    return undefined;
  }

  return {
    login_ticket: metadata.login_ticket,
    ...(metadata.user_id ? { user_id: metadata.user_id } : {}),
    ...(metadata.channel ? { channel: metadata.channel } : {}),
    ...(metadata.tenant_key ? { tenant_key: metadata.tenant_key } : {}),
  };
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePath(path: string | undefined, fallback: string): string {
  const normalized = trimString(path) ?? fallback;
  if (normalized.startsWith("/")) {
    return normalized;
  }
  return `/${normalized}`;
}

function parseExpireAtMs(value: unknown): number {
  const normalizeEpoch = (raw: number): number => {
    // Accept seconds-based epoch from upstream and normalize to milliseconds.
    if (raw < 1_000_000_000_000) {
      return raw * 1000;
    }
    return raw;
  };

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return normalizeEpoch(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Only treat pure digits as epoch input; ISO timestamps must go through Date.parse.
    if (/^\d+$/.test(trimmed)) {
      const fromNumber = Number.parseInt(trimmed, 10);
      if (Number.isFinite(fromNumber) && fromNumber > 0) {
        return normalizeEpoch(fromNumber);
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now() + DEFAULT_CARD_TTL_MS;
}

function parseCaptchaBase64(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const payload = trimmed.startsWith("data:") ? (trimmed.split(",", 2)[1]?.trim() ?? "") : trimmed;
  if (!payload) {
    return null;
  }
  try {
    const buffer = Buffer.from(payload, "base64");
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

function parseCardPayload(raw: unknown): JwxtLoginCardPayload | null {
  if (!isRecord(raw)) {
    return null;
  }

  const captcha = isRecord(raw.captcha) ? raw.captcha : null;
  const hidden = isRecord(raw.hidden) ? raw.hidden : null;
  const submit = isRecord(raw.submit) ? raw.submit : null;

  const captchaImageBase64 = trimString(captcha?.image_base64);
  const loginTicket = trimString(hidden?.login_ticket);
  if (!captchaImageBase64 || !loginTicket) {
    return null;
  }

  return {
    title: trimString(raw.title) ?? "教务系统登录已过期",
    description:
      trimString(raw.description) ?? "请填写学号、密码和验证码，提交后将自动继续刚才的查询。",
    captchaImageBase64,
    hidden: {
      loginTicket,
      userId: trimString(hidden?.user_id),
      channel: trimString(hidden?.channel),
      tenantKey: trimString(hidden?.tenant_key),
    },
    submitLabel: trimString(submit?.label) ?? "登录并继续查询",
    expireAtMs: parseExpireAtMs(raw.expire_at),
  };
}

function parseJwxtLoginFlowConfig(
  cfg: ClawdbotConfig,
  accountId?: string,
): FeishuJwxtLoginFlowRuntimeConfig | null {
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const raw = isRecord((account.config as Record<string, unknown>).jwxtLoginFlow)
    ? ((account.config as Record<string, unknown>).jwxtLoginFlow as Record<string, unknown>)
    : null;
  if (!raw) {
    return null;
  }

  const baseUrl = trimString(raw.baseUrl);
  if (!baseUrl) {
    return {
      enabled: false,
      baseUrl: "",
      startPath: DEFAULT_START_PATH,
      submitPath: DEFAULT_SUBMIT_PATH,
      tenantKey: "default",
      authHeader: undefined,
      authHeaderName: "Authorization",
      keywordPatterns: DEFAULT_KEYWORDS,
      defaultToolName: DEFAULT_TOOL_NAME,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };
  }

  const timeoutMsValue = raw.timeoutMs;
  const parsedTimeout =
    typeof timeoutMsValue === "number" && Number.isFinite(timeoutMsValue) && timeoutMsValue > 0
      ? Math.floor(timeoutMsValue)
      : DEFAULT_TIMEOUT_MS;

  const keywordPatterns = Array.isArray(raw.keywordPatterns)
    ? raw.keywordPatterns
        .map((entry) => trimString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];

  return {
    enabled: raw.enabled !== false,
    baseUrl,
    startPath: normalizePath(trimString(raw.startPath), DEFAULT_START_PATH),
    submitPath: normalizePath(trimString(raw.submitPath), DEFAULT_SUBMIT_PATH),
    tenantKey: trimString(raw.tenantKey) ?? "default",
    authHeader: trimString(raw.authHeader),
    authHeaderName: trimString(raw.authHeaderName) ?? "Authorization",
    keywordPatterns: keywordPatterns.length > 0 ? keywordPatterns : DEFAULT_KEYWORDS,
    defaultToolName: trimString(raw.defaultToolName) ?? DEFAULT_TOOL_NAME,
    timeoutMs: parsedTimeout,
  };
}

function resolveJwxtIntent(text: string, config: FeishuJwxtLoginFlowRuntimeConfig): JwxtIntent {
  const normalized = normalizeOptionalString(text) ?? "";
  if (!normalized) {
    return {
      hasIntent: false,
      toolName: config.defaultToolName,
    };
  }

  if (SECOND_CLASS_HINT.test(normalized)) {
    return {
      hasIntent: false,
      toolName: config.defaultToolName,
    };
  }

  const hasExplicitJwxtQuery =
    JWXT_ACTION_VERB_HINT.test(normalized) && JWXT_DOMAIN_HINT.test(normalized);

  // Keep generic "course recommendation" utterances on the normal LLM->MCP path.
  if (COURSE_RECOMMENDATION_HINT.test(normalized) && !hasExplicitJwxtQuery) {
    return {
      hasIntent: false,
      toolName: config.defaultToolName,
    };
  }

  if (AMBIGUOUS_CREDIT_HINT.test(normalized) && !JWXT_STRONG_SIGNAL_HINT.test(normalized)) {
    return {
      hasIntent: false,
      toolName: config.defaultToolName,
    };
  }

  const hasKeyword = config.keywordPatterns.some((keyword) => normalized.includes(keyword));
  const hasFallbackIntentHint = JWXT_FALLBACK_INTENT_HINT.test(normalized);
  if (!hasKeyword && !hasFallbackIntentHint) {
    return {
      hasIntent: false,
      toolName: config.defaultToolName,
    };
  }

  if (SCHEDULE_HINT.test(normalized)) {
    return { hasIntent: true, toolName: "jwxt.get_schedule" };
  }
  return {
    hasIntent: true,
    toolName: config.defaultToolName,
  };
}

function buildRequestUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return {};
  }
  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return { raw: rawText };
  }
}

async function postJson(params: {
  url: string;
  body: Record<string, unknown>;
  config: FeishuJwxtLoginFlowRuntimeConfig;
}): Promise<JwxtRequestResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.config.authHeader) {
    headers[params.config.authHeaderName] = params.config.authHeader;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), params.config.timeoutMs);

  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal: abortController.signal,
    });
    return {
      status: response.status,
      body: await parseJsonResponse(response),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function readReplayText(value: unknown): string {
  const direct = trimString(value);
  if (direct) {
    return direct;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function normalizeReplayTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").trim() || "-";
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "-";
}

function readReplayField(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (!(key in row)) {
      continue;
    }
    const value = readReplayText(row[key]);
    if (value) {
      return value;
    }
  }
  return "-";
}

function readReplayCount(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return fallback;
}

function formatGradeReplaySummary(params: {
  toolName: string;
  data: Record<string, unknown>;
}): string | undefined {
  const rawGrades = Array.isArray(params.data.grades) ? params.data.grades : [];
  const gradeRows = rawGrades.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  if (gradeRows.length === 0) {
    return undefined;
  }

  const totalCount = Math.max(
    readReplayCount(params.data.count, gradeRows.length),
    gradeRows.length,
  );
  const maxRows = 50;
  const visibleRows = gradeRows.slice(0, maxRows);

  const tableLines = [
    "| 序号 | 学期 | 课程 | 学分 | 成绩 | 考核 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (let index = 0; index < visibleRows.length; index += 1) {
    const row = visibleRows[index];
    const cells = [
      String(index + 1),
      readReplayField(row, ["semester", "term"]),
      readReplayField(row, ["courseName", "course_name", "name"]),
      readReplayField(row, ["credit", "credits"]),
      readReplayField(row, ["score", "finalScore", "final_score", "grade"]),
      readReplayField(row, ["examType", "exam_type", "assessment"]),
    ].map(escapeMarkdownTableCell);
    tableLines.push(`| ${cells.join(" | ")} |`);
  }

  const lines = [
    `已自动继续查询（${params.toolName}），共 ${totalCount} 门：`,
    "",
    tableLines.join("\n"),
  ];
  if (gradeRows.length > visibleRows.length) {
    lines.push(
      `\n仅展示前 ${visibleRows.length} 门，剩余 ${gradeRows.length - visibleRows.length} 门可继续查看明细。`,
    );
  }
  return lines.join("\n");
}

function formatScheduleReplaySummary(params: {
  toolName: string;
  data: Record<string, unknown>;
}): string | undefined {
  const structuredRows = Array.isArray(params.data.structured)
    ? params.data.structured.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const courseRows = Array.isArray(params.data.courses)
    ? params.data.courses.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];

  const rows = structuredRows.length > 0 ? structuredRows : courseRows;
  if (rows.length === 0) {
    return undefined;
  }

  const totalCount = Math.max(readReplayCount(params.data.courseCount, rows.length), rows.length);
  const maxRows = 30;
  const visibleRows = rows.slice(0, maxRows);
  const tableLines = [
    "| 序号 | 星期 | 时段 | 课程 | 地点 | 教师 | 周次 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (let index = 0; index < visibleRows.length; index += 1) {
    const row = visibleRows[index];
    const cells = [
      String(index + 1),
      readReplayField(row, ["weekDay", "day", "weekday"]),
      readReplayField(row, ["timeSlot", "section", "time"]),
      readReplayField(row, ["name", "courseName", "course"]),
      readReplayField(row, ["location", "classroom", "room"]),
      readReplayField(row, ["teacher", "instructor"]),
      readReplayField(row, ["weeks", "weekRange", "weekSpan"]),
    ].map(escapeMarkdownTableCell);
    tableLines.push(`| ${cells.join(" | ")} |`);
  }

  const lines = [
    `已自动继续查询（${params.toolName}），共 ${totalCount} 条课程安排：`,
    "",
    tableLines.join("\n"),
  ];
  if (rows.length > visibleRows.length) {
    lines.push(
      `\n仅展示前 ${visibleRows.length} 条，剩余 ${rows.length - visibleRows.length} 条可继续查看明细。`,
    );
  }
  return lines.join("\n");
}

function buildFeishuReplayTableCard(params: {
  title: string;
  summary: string;
  columns: Record<string, unknown>[];
  rows: Record<string, unknown>[];
  footerNote?: string;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: params.summary,
    },
    {
      tag: "table",
      page_size: 10,
      row_height: "auto",
      header_style: {
        text_align: "left",
        text_size: "normal",
        background_style: "grey",
        bold: true,
        lines: 1,
      },
      columns: params.columns,
      rows: params.rows,
    },
  ];

  if (params.footerNote) {
    elements.push({
      tag: "markdown",
      content: `<font color='grey'>${params.footerNote}</font>`,
    });
  }

  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    header: {
      title: {
        tag: "plain_text",
        content: params.title,
      },
      template: "blue",
    },
    body: {
      elements,
    },
  };
}

function buildGradeReplayTableCard(params: {
  baseText: string;
  toolName: string;
  data: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const rawGrades = Array.isArray(params.data.grades) ? params.data.grades : [];
  const gradeRows = rawGrades.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  if (gradeRows.length === 0) {
    return undefined;
  }

  const totalCount = Math.max(
    readReplayCount(params.data.count, gradeRows.length),
    gradeRows.length,
  );
  const maxRows = 50;
  const visibleRows = gradeRows.slice(0, maxRows);
  const rows = visibleRows.map((row, index) => ({
    index: String(index + 1),
    semester: normalizeReplayTableCell(readReplayField(row, ["semester", "term"])),
    course: normalizeReplayTableCell(readReplayField(row, ["courseName", "course_name", "name"])),
    credit: normalizeReplayTableCell(readReplayField(row, ["credit", "credits"])),
    score: normalizeReplayTableCell(
      readReplayField(row, ["score", "finalScore", "final_score", "grade"]),
    ),
    exam_type: normalizeReplayTableCell(
      readReplayField(row, ["examType", "exam_type", "assessment"]),
    ),
  }));

  const columns: Record<string, unknown>[] = [
    { name: "index", display_name: "序号", data_type: "text", width: "80px" },
    { name: "semester", display_name: "学期", data_type: "text", width: "140px" },
    { name: "course", display_name: "课程", data_type: "text", width: "auto" },
    {
      name: "credit",
      display_name: "学分",
      data_type: "text",
      width: "80px",
      horizontal_align: "center",
    },
    {
      name: "score",
      display_name: "成绩",
      data_type: "text",
      width: "80px",
      horizontal_align: "center",
    },
    { name: "exam_type", display_name: "考核", data_type: "text", width: "100px" },
  ];

  const footerNote =
    gradeRows.length > visibleRows.length
      ? `仅展示前 ${visibleRows.length} 门，剩余 ${gradeRows.length - visibleRows.length} 门可继续查看明细。`
      : undefined;

  return buildFeishuReplayTableCard({
    title: "成绩查询结果",
    summary: `${params.baseText}\n\n已自动继续查询（${params.toolName}），共 ${totalCount} 门：`,
    columns,
    rows,
    footerNote,
  });
}

function buildScheduleReplayTableCard(params: {
  baseText: string;
  toolName: string;
  data: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const structuredRows = Array.isArray(params.data.structured)
    ? params.data.structured.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const courseRows = Array.isArray(params.data.courses)
    ? params.data.courses.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const rowsSource = structuredRows.length > 0 ? structuredRows : courseRows;
  if (rowsSource.length === 0) {
    return undefined;
  }

  const totalCount = Math.max(
    readReplayCount(params.data.courseCount, rowsSource.length),
    rowsSource.length,
  );
  const maxRows = 30;
  const visibleRows = rowsSource.slice(0, maxRows);
  const rows = visibleRows.map((row, index) => ({
    index: String(index + 1),
    week_day: normalizeReplayTableCell(readReplayField(row, ["weekDay", "day", "weekday"])),
    time_slot: normalizeReplayTableCell(readReplayField(row, ["timeSlot", "section", "time"])),
    course: normalizeReplayTableCell(readReplayField(row, ["name", "courseName", "course"])),
    location: normalizeReplayTableCell(readReplayField(row, ["location", "classroom", "room"])),
    teacher: normalizeReplayTableCell(readReplayField(row, ["teacher", "instructor"])),
    weeks: normalizeReplayTableCell(readReplayField(row, ["weeks", "weekRange", "weekSpan"])),
  }));

  const columns: Record<string, unknown>[] = [
    { name: "index", display_name: "序号", data_type: "text", width: "80px" },
    { name: "week_day", display_name: "星期", data_type: "text", width: "100px" },
    { name: "time_slot", display_name: "时段", data_type: "text", width: "120px" },
    { name: "course", display_name: "课程", data_type: "text", width: "auto" },
    { name: "location", display_name: "地点", data_type: "text", width: "130px" },
    { name: "teacher", display_name: "教师", data_type: "text", width: "100px" },
    { name: "weeks", display_name: "周次", data_type: "text", width: "120px" },
  ];

  const footerNote =
    rowsSource.length > visibleRows.length
      ? `仅展示前 ${visibleRows.length} 条，剩余 ${rowsSource.length - visibleRows.length} 条可继续查看明细。`
      : undefined;

  return buildFeishuReplayTableCard({
    title: "课表查询结果",
    summary: `${params.baseText}\n\n已自动继续查询（${params.toolName}），共 ${totalCount} 条课程安排：`,
    columns,
    rows,
    footerNote,
  });
}

function buildReplayTableCardFromResult(params: {
  baseText: string;
  replayResult: unknown;
}): Record<string, unknown> | undefined {
  if (!isRecord(params.replayResult) || params.replayResult.success !== true) {
    return undefined;
  }

  const toolName = trimString(params.replayResult.tool) ?? "jwxt";
  const data = isRecord(params.replayResult.data) ? params.replayResult.data : params.replayResult;
  if (toolName === "jwxt.get_grades") {
    return buildGradeReplayTableCard({
      baseText: params.baseText,
      toolName,
      data,
    });
  }

  if (toolName === "jwxt.get_schedule") {
    return buildScheduleReplayTableCard({
      baseText: params.baseText,
      toolName,
      data,
    });
  }

  return undefined;
}

function formatBackendTextReplaySummary(params: {
  toolName: string;
  data: Record<string, unknown>;
}): string | undefined {
  const textResult = readReplayText(params.data.textResult);
  if (!textResult) {
    return undefined;
  }
  // Reuse Flask-produced markdown directly so presentation stays backend-owned.
  return `已自动继续查询（${params.toolName}）：\n\n${textResult.trim()}`;
}

function formatReplayHighlights(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (
      key === "grades" ||
      key === "structured" ||
      key === "courses" ||
      key === "rawHtml" ||
      key === "textResult"
    ) {
      continue;
    }

    const scalar = readReplayText(value);
    if (scalar) {
      const brief = scalar.length > 180 ? `${scalar.slice(0, 180)}...` : scalar;
      lines.push(`- ${key}：${brief}`);
    } else if (Array.isArray(value)) {
      lines.push(`- ${key}：共 ${value.length} 项`);
    }

    if (lines.length >= 6) {
      break;
    }
  }
  return lines;
}

function formatReplaySummary(replayResult: unknown): string | undefined {
  if (!isRecord(replayResult)) {
    return undefined;
  }
  const replaySuccess = replayResult.success === true;
  const toolName = trimString(replayResult.tool) ?? "jwxt";
  if (replaySuccess) {
    const data = isRecord(replayResult.data) ? replayResult.data : replayResult;

    const backendTextSummary = formatBackendTextReplaySummary({ toolName, data });
    if (backendTextSummary) {
      return backendTextSummary;
    }

    const gradeSummary = formatGradeReplaySummary({ toolName, data });
    if (gradeSummary) {
      return gradeSummary;
    }

    const scheduleSummary = formatScheduleReplaySummary({ toolName, data });
    if (scheduleSummary) {
      return scheduleSummary;
    }

    const highlights = formatReplayHighlights(data);
    if (highlights.length > 0) {
      return `已自动继续查询（${toolName}）：\n${highlights.join("\n")}`;
    }

    return `已自动继续查询（${toolName}）。`;
  }
  const error = isRecord(replayResult.error) ? replayResult.error : null;
  const userMessage = trimString(error?.userMessage) ?? trimString(error?.message);
  if (userMessage) {
    return `登录成功，但自动重放失败：${userMessage}`;
  }
  return `登录成功，但自动重放失败（${toolName}）。`;
}

function shouldRenderAsMarkdownCard(text: string): boolean {
  return (
    /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text) ||
    /(^|\n)#{1,6}\s/.test(text) ||
    /```[\s\S]*?```/.test(text)
  );
}

async function sendJwxtFlowMessage(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
  preferCard?: boolean;
}): Promise<void> {
  if (!params.text.trim()) {
    return;
  }

  const useCard = params.preferCard === true || shouldRenderAsMarkdownCard(params.text);
  if (useCard) {
    await sendMarkdownCardFeishu({
      cfg: params.cfg,
      to: params.to,
      text: params.text,
      replyToMessageId: params.replyToMessageId,
      replyInThread: params.replyInThread,
      accountId: params.accountId,
    });
    return;
  }

  await sendMessageFeishu({
    cfg: params.cfg,
    to: params.to,
    text: params.text,
    replyToMessageId: params.replyToMessageId,
    replyInThread: params.replyInThread,
    accountId: params.accountId,
  });
}

async function buildFeishuLoginCard(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  operatorOpenId: string;
  chatId: string;
  chatType: FeishuCardChatType;
  sessionKey?: string;
  cardPayload: JwxtLoginCardPayload;
  runtime?: RuntimeEnv;
}): Promise<Record<string, unknown> | null> {
  const { cardPayload } = params;
  const captchaBuffer = parseCaptchaBase64(cardPayload.captchaImageBase64);
  if (!captchaBuffer) {
    return null;
  }

  let imageKey: string | null = null;
  try {
    const uploaded = await uploadImageFeishu({
      cfg: params.cfg,
      image: captchaBuffer,
      accountId: params.accountId,
    });
    imageKey = uploaded.imageKey;
  } catch (error) {
    params.runtime?.error?.(
      `feishu[${params.accountId ?? "default"}]: captcha upload failed: ${String(error)}`,
    );
    return null;
  }

  const context = buildFeishuCardInteractionContext({
    operatorOpenId: params.operatorOpenId,
    chatId: params.chatId,
    chatType: params.chatType,
    sessionKey: params.sessionKey,
    expiresAt: cardPayload.expireAtMs,
  });

  const submitEnvelope = createFeishuCardInteractionEnvelope({
    k: "button",
    a: FEISHU_JWXT_LOGIN_SUBMIT_ACTION,
    m: {
      login_ticket: cardPayload.hidden.loginTicket,
      user_id: cardPayload.hidden.userId ?? params.operatorOpenId,
      channel: cardPayload.hidden.channel ?? "feishu",
      tenant_key: cardPayload.hidden.tenantKey,
    },
    c: context,
  });

  cacheFeishuJwxtSubmitEnvelopeMetadata({
    accountId: params.accountId,
    operatorOpenId: params.operatorOpenId,
    chatId: params.chatId,
    metadata: submitEnvelope.m ?? {},
    expiresAtMs: cardPayload.expireAtMs,
  });

  const expiresAtText = new Date(cardPayload.expireAtMs).toLocaleString("zh-CN", {
    hour12: false,
  });

  const submitButton = {
    ...buildFeishuCardButton({
      label: cardPayload.submitLabel,
      type: "primary",
      value: submitEnvelope,
      name: FEISHU_JWXT_LOGIN_SUBMIT_BUTTON_NAME,
      formActionType: "submit",
    }),
    behaviors: [
      {
        type: "callback",
        value: submitEnvelope,
      },
    ],
  };

  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    header: {
      title: {
        tag: "plain_text",
        content: cardPayload.title,
      },
      template: "orange",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: cardPayload.description,
        },
        {
          tag: "img",
          img_key: imageKey,
          alt: {
            tag: "plain_text",
            content: "验证码",
          },
        },
        {
          tag: "form",
          name: "jwxt_login_form",
          elements: [
            {
              tag: "input",
              name: "student_id",
              required: true,
              placeholder: {
                tag: "plain_text",
                content: "请输入学号",
              },
            },
            {
              tag: "input",
              name: "password",
              input_type: "password",
              required: true,
              placeholder: {
                tag: "plain_text",
                content: "请输入密码",
              },
            },
            {
              tag: "input",
              name: "captcha_code",
              required: true,
              placeholder: {
                tag: "plain_text",
                content: "请输入验证码",
              },
            },
            {
              tag: "column_set",
              horizontal_align: "right",
              columns: [
                {
                  tag: "column",
                  width: "auto",
                  elements: [submitButton],
                },
              ],
            },
          ],
        },
        {
          tag: "markdown",
          content: `<font color='grey'>此验证码将于 ${expiresAtText} 过期</font>`,
        },
      ],
    },
  };
}

export async function maybeStartFeishuJwxtLoginFlow(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  runtime?: RuntimeEnv;
  operatorOpenId: string;
  chatId: string;
  chatType: FeishuCardChatType;
  messageText: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  sessionKey?: string;
}): Promise<boolean> {
  const flowConfig = parseJwxtLoginFlowConfig(params.cfg, params.accountId);
  if (!flowConfig || !flowConfig.enabled || !flowConfig.baseUrl) {
    return false;
  }

  const messageText = params.messageText.trim();
  if (!messageText || messageText.startsWith("/")) {
    return false;
  }

  const intent = resolveJwxtIntent(messageText, flowConfig);
  if (!intent.hasIntent) {
    return false;
  }

  let startResponse: JwxtRequestResult;
  try {
    startResponse = await postJson({
      url: buildRequestUrl(flowConfig.baseUrl, flowConfig.startPath),
      config: flowConfig,
      body: {
        user_id: params.operatorOpenId,
        tool_name: intent.toolName,
        arguments: {},
        channel: "feishu",
        tenant_key: flowConfig.tenantKey,
      },
    });
  } catch (error) {
    params.runtime?.error?.(
      `feishu[${params.accountId ?? "default"}]: jwxt login start request failed: ${String(error)}`,
    );
    return false;
  }

  const payload = isRecord(startResponse.body)
    ? (startResponse.body as JwxtStartResponse)
    : ({} as JwxtStartResponse);
  const needLogin = payload.need_login === true;

  if (!needLogin) {
    const replaySummary = formatReplaySummary(payload.replay_result);
    if (payload.success === true || replaySummary) {
      const baseText = trimString(payload.user_message) ?? "会话有效，已返回查询结果。";
      const replayTableCard = buildReplayTableCardFromResult({
        baseText,
        replayResult: payload.replay_result,
      });
      if (replayTableCard) {
        await sendCardFeishu({
          cfg: params.cfg,
          to: `chat:${params.chatId}`,
          card: replayTableCard,
          replyToMessageId: params.replyToMessageId,
          replyInThread: params.replyInThread,
          accountId: params.accountId,
        });
        return true;
      }
      await sendJwxtFlowMessage({
        cfg: params.cfg,
        to: `chat:${params.chatId}`,
        text: replaySummary ? `${baseText}\n\n${replaySummary}` : baseText,
        replyToMessageId: params.replyToMessageId,
        replyInThread: params.replyInThread,
        accountId: params.accountId,
        preferCard: Boolean(replaySummary),
      });
      return true;
    }

    const nonLoginMessage = trimString(payload.user_message);
    if (nonLoginMessage) {
      await sendMessageFeishu({
        cfg: params.cfg,
        to: `chat:${params.chatId}`,
        text: nonLoginMessage,
        replyToMessageId: params.replyToMessageId,
        replyInThread: params.replyInThread,
        accountId: params.accountId,
      });
      return true;
    }

    if (startResponse.status >= 400) {
      const text = trimString(payload.user_message) ?? "教务系统登录流程暂时不可用，请稍后重试。";
      await sendMessageFeishu({
        cfg: params.cfg,
        to: `chat:${params.chatId}`,
        text,
        replyToMessageId: params.replyToMessageId,
        replyInThread: params.replyInThread,
        accountId: params.accountId,
      });
      return true;
    }
    return false;
  }

  const cardPayload = parseCardPayload(payload.card_payload);
  if (!cardPayload) {
    await sendMessageFeishu({
      cfg: params.cfg,
      to: `chat:${params.chatId}`,
      text: "检测到教务登录已失效，但验证码卡片生成失败，请稍后重试。",
      replyToMessageId: params.replyToMessageId,
      replyInThread: params.replyInThread,
      accountId: params.accountId,
    });
    return true;
  }

  const card = await buildFeishuLoginCard({
    cfg: params.cfg,
    accountId: params.accountId,
    operatorOpenId: params.operatorOpenId,
    chatId: params.chatId,
    chatType: params.chatType,
    sessionKey: params.sessionKey,
    cardPayload,
    runtime: params.runtime,
  });

  if (!card) {
    await sendMessageFeishu({
      cfg: params.cfg,
      to: `chat:${params.chatId}`,
      text: "验证码图片上传失败，请稍后重试。",
      replyToMessageId: params.replyToMessageId,
      replyInThread: params.replyInThread,
      accountId: params.accountId,
    });
    return true;
  }

  await sendCardFeishu({
    cfg: params.cfg,
    to: `chat:${params.chatId}`,
    card,
    replyToMessageId: params.replyToMessageId,
    replyInThread: params.replyInThread,
    accountId: params.accountId,
  });
  return true;
}

function readFormScalar(value: unknown): string {
  const direct = trimString(value);
  if (direct) {
    return direct;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = readFormScalar(item);
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }

  if (isRecord(value)) {
    for (const key of ["value", "text", "content", "id"]) {
      if (key in value) {
        const candidate = readFormScalar(value[key]);
        if (candidate) {
          return candidate;
        }
      }
    }
  }

  return "";
}

function readFormValue(
  event: {
    action: {
      form_value?: Record<string, unknown>;
    };
  },
  key: string,
  aliasPatterns?: RegExp[],
): string {
  const formValue = event.action.form_value;
  const direct = readFormScalar(formValue?.[key]);
  if (direct || !formValue || !aliasPatterns || aliasPatterns.length === 0) {
    return direct;
  }

  for (const [fieldName, fieldValue] of Object.entries(formValue)) {
    if (!aliasPatterns.some((pattern) => pattern.test(fieldName))) {
      continue;
    }
    const candidate = readFormScalar(fieldValue);
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

export async function handleFeishuJwxtLoginSubmit(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  runtime?: RuntimeEnv;
  event: {
    operator: {
      open_id: string;
    };
    action: {
      form_value?: Record<string, unknown>;
    };
    context: {
      chat_id: string;
    };
  };
  envelopeMetadata?: Record<string, unknown>;
  chatType?: FeishuCardChatType;
  sessionKey?: string;
}): Promise<boolean> {
  const flowConfig = parseJwxtLoginFlowConfig(params.cfg, params.accountId);
  if (!flowConfig || !flowConfig.enabled || !flowConfig.baseUrl) {
    return false;
  }

  const metadata = params.envelopeMetadata ?? {};
  const loginTicket = trimString(metadata.login_ticket);
  if (!loginTicket) {
    await sendMessageFeishu({
      cfg: params.cfg,
      to: `chat:${params.event.context.chat_id}`,
      text: "登录票据已失效，请重新触发一次查询。",
      accountId: params.accountId,
    });
    return true;
  }

  const studentId = readFormValue(params.event, "student_id", [/student/i, /学号/u, /stu/i]);
  const password = readFormValue(params.event, "password", [
    /password/i,
    /passwd/i,
    /pwd/i,
    /密码/u,
  ]);
  const captchaCode = readFormValue(params.event, "captcha_code", [
    /captcha/i,
    /verify/i,
    /code/i,
    /验证码/u,
  ]);

  if (!studentId || !password || !captchaCode) {
    const formValue = params.event.action.form_value ?? {};
    const fieldKeys = Object.keys(formValue);
    const fieldTypeSummary = fieldKeys
      .map((fieldName) => {
        const fieldValue = formValue[fieldName];
        const type = Array.isArray(fieldValue) ? "array" : typeof fieldValue;
        return `${fieldName}:${type}`;
      })
      .join(", ");
    params.runtime?.log?.(
      `feishu[${params.accountId ?? "default"}]: jwxt login submit missing required fields (keys=${fieldKeys.join(",") || "none"}; types=${fieldTypeSummary || "none"})`,
    );
    await sendMessageFeishu({
      cfg: params.cfg,
      to: `chat:${params.event.context.chat_id}`,
      text: "请填写完整的学号、密码和验证码后再提交。",
      accountId: params.accountId,
    });
    return true;
  }

  let submitResponse: JwxtRequestResult;
  try {
    submitResponse = await postJson({
      url: buildRequestUrl(flowConfig.baseUrl, flowConfig.submitPath),
      config: flowConfig,
      body: {
        login_ticket: loginTicket,
        student_id: studentId,
        password,
        captcha_code: captchaCode,
        user_id: trimString(metadata.user_id) ?? params.event.operator.open_id,
        channel: trimString(metadata.channel) ?? "feishu",
        tenant_key: trimString(metadata.tenant_key) ?? flowConfig.tenantKey,
      },
    });
  } catch (error) {
    params.runtime?.error?.(
      `feishu[${params.accountId ?? "default"}]: jwxt login submit request failed: ${String(error)}`,
    );
    await sendMessageFeishu({
      cfg: params.cfg,
      to: `chat:${params.event.context.chat_id}`,
      text: "登录请求失败，请稍后重试。",
      accountId: params.accountId,
    });
    return true;
  }

  const payload = isRecord(submitResponse.body)
    ? (submitResponse.body as JwxtSubmitResponse)
    : ({} as JwxtSubmitResponse);

  if (payload.success === true) {
    const userMessage = trimString(payload.user_message) ?? "登录成功，正在继续查询。";
    const replayTableCard = buildReplayTableCardFromResult({
      baseText: userMessage,
      replayResult: payload.replay_result,
    });
    if (replayTableCard) {
      await sendCardFeishu({
        cfg: params.cfg,
        to: `chat:${params.event.context.chat_id}`,
        card: replayTableCard,
        accountId: params.accountId,
      });
      return true;
    }
    const replaySummary = formatReplaySummary(payload.replay_result);
    await sendJwxtFlowMessage({
      cfg: params.cfg,
      to: `chat:${params.event.context.chat_id}`,
      text: replaySummary ? `${userMessage}\n\n${replaySummary}` : userMessage,
      accountId: params.accountId,
      preferCard: Boolean(replaySummary),
    });
    return true;
  }

  const refreshedCardPayload = parseCardPayload(payload.card_payload);
  if (refreshedCardPayload) {
    const refreshedCard = await buildFeishuLoginCard({
      cfg: params.cfg,
      accountId: params.accountId,
      operatorOpenId: params.event.operator.open_id,
      chatId: params.event.context.chat_id,
      chatType: params.chatType ?? "group",
      sessionKey: params.sessionKey,
      cardPayload: refreshedCardPayload,
      runtime: params.runtime,
    });
    if (refreshedCard) {
      await sendCardFeishu({
        cfg: params.cfg,
        to: `chat:${params.event.context.chat_id}`,
        card: refreshedCard,
        accountId: params.accountId,
      });
      const hint = trimString(payload.user_message);
      if (hint) {
        await sendMessageFeishu({
          cfg: params.cfg,
          to: `chat:${params.event.context.chat_id}`,
          text: hint,
          accountId: params.accountId,
        });
      }
      return true;
    }
  }

  await sendMessageFeishu({
    cfg: params.cfg,
    to: `chat:${params.event.context.chat_id}`,
    text: trimString(payload.user_message) ?? "登录失败，请重新尝试。",
    accountId: params.accountId,
  });
  return true;
}
