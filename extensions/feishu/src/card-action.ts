import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { decodeFeishuCardAction, buildFeishuCardActionTextFallback } from "./card-interaction.js";
import {
  createApprovalCard,
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";
import {
  FEISHU_JWXT_LOGIN_REFRESH_ACTION,
  FEISHU_JWXT_LOGIN_SUBMIT_BUTTON_NAME,
  FEISHU_JWXT_LOGIN_SUBMIT_ACTION,
  handleFeishuJwxtLoginRefresh,
  handleFeishuJwxtLoginSubmit,
  resolveFeishuJwxtLoginSubmitMetadataFallback,
} from "./jwxt-login-flow.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";

const FEISHU_CHAT_ID_PREFIX = "oc_";
const FEISHU_OPEN_ID_PREFIX = "ou_";
const FEISHU_CALLBACK_TARGET_PREFIX = /^(chat|group|channel|user|dm|open_id|p2p):/i;
const FEISHU_INVALID_RECEIVE_ID_CODE = 230001;

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
    name?: string;
    form_value?: Record<string, unknown>;
  };
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
    message_id?: string;
  };
};

const FEISHU_APPROVAL_CARD_TTL_MS = 5 * 60_000;
const FEISHU_CARD_ACTION_TOKEN_TTL_MS = 15 * 60_000;
const processedCardActionTokens = new Map<
  string,
  { status: "inflight" | "completed"; expiresAt: number }
>();

export class FeishuRetryableCardActionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeishuRetryableCardActionError";
  }
}

export function resetProcessedFeishuCardActionTokensForTests(): void {
  processedCardActionTokens.clear();
}

function pruneProcessedCardActionTokens(now: number): void {
  for (const [key, entry] of processedCardActionTokens.entries()) {
    if (entry.expiresAt <= now) {
      processedCardActionTokens.delete(key);
    }
  }
}

function beginFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  pruneProcessedCardActionTokens(now);
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return false;
  }
  const key = `${params.accountId}:${normalizedToken}`;
  const existing = processedCardActionTokens.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }
  processedCardActionTokens.set(key, {
    status: "inflight",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
  return true;
}

function completeFeishuCardActionToken(params: {
  token: string;
  accountId: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.set(`${params.accountId}:${normalizedToken}`, {
    status: "completed",
    expiresAt: now + FEISHU_CARD_ACTION_TOKEN_TTL_MS,
  });
}

function releaseFeishuCardActionToken(params: { token: string; accountId: string }): void {
  const normalizedToken = params.token.trim();
  if (!normalizedToken) {
    return;
  }
  processedCardActionTokens.delete(`${params.accountId}:${normalizedToken}`);
}

function buildSyntheticMessageEvent(
  event: FeishuCardActionEvent,
  content: string,
  chatType?: "p2p" | "group",
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: chatType ?? (event.context.chat_id ? "group" : "p2p"),
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };
}

function normalizeCallbackIdentifier(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(FEISHU_CALLBACK_TARGET_PREFIX, "").trim();
}

function resolveCallbackTarget(event: FeishuCardActionEvent): string {
  const candidates = [event.context.chat_id, event.context.open_id, event.operator.open_id];
  for (const candidate of candidates) {
    const normalized = normalizeCallbackIdentifier(candidate);
    if (!normalized) {
      continue;
    }
    if (normalized.startsWith(FEISHU_CHAT_ID_PREFIX)) {
      return `chat:${normalized}`;
    }
    if (normalized.startsWith(FEISHU_OPEN_ID_PREFIX)) {
      return `user:${normalized}`;
    }
  }
  const chatId = event.context.chat_id?.trim();
  if (chatId) {
    return `chat:${chatId}`;
  }
  return `user:${event.operator.open_id}`;
}

function resolveUserCallbackTarget(event: FeishuCardActionEvent): string {
  const candidates = [event.context.open_id, event.operator.open_id, event.context.chat_id];
  for (const candidate of candidates) {
    const normalized = normalizeCallbackIdentifier(candidate);
    if (normalized.startsWith(FEISHU_OPEN_ID_PREFIX)) {
      return `user:${normalized}`;
    }
  }
  return `user:${event.operator.open_id}`;
}

function isLikelyJwxtFormSubmitAction(action: FeishuCardActionEvent["action"]): boolean {
  const name = action.name?.trim() ?? "";
  if (name === FEISHU_JWXT_LOGIN_SUBMIT_BUTTON_NAME) {
    return true;
  }

  if (!action.form_value || typeof action.form_value !== "object") {
    return false;
  }

  const keys = Object.keys(action.form_value);
  return keys.includes("student_id") || keys.includes("password") || keys.includes("captcha_code");
}

function isInvalidReceiveIdError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }

  const code = (err as { code?: number }).code;
  if (code === FEISHU_INVALID_RECEIVE_ID_CODE) {
    return true;
  }

  const response = (err as { response?: { data?: { code?: number; msg?: string } } }).response;
  if (response?.data?.code === FEISHU_INVALID_RECEIVE_ID_CODE) {
    return true;
  }

  const combinedMessage =
    `${(err as { message?: string }).message ?? ""} ${response?.data?.msg ?? ""}`
      .toLowerCase()
      .trim();
  return combinedMessage.includes("invalid receive_id");
}

async function dispatchSyntheticCommand(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  command: string;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  chatType?: "p2p" | "group";
}): Promise<void> {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: buildSyntheticMessageEvent(params.event, params.command, params.chatType),
    botOpenId: params.botOpenId,
    runtime: params.runtime,
    accountId: params.accountId,
  });
}

async function sendInvalidInteractionNotice(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  reason: "malformed" | "stale" | "wrong_user" | "wrong_conversation";
  accountId?: string;
}): Promise<void> {
  const reasonText =
    params.reason === "stale"
      ? "This card action has expired. Open a fresh launcher card and try again."
      : params.reason === "wrong_user"
        ? "This card action belongs to a different user."
        : params.reason === "wrong_conversation"
          ? "This card action belongs to a different conversation."
          : "This card action payload is invalid.";

  const primaryTarget = resolveCallbackTarget(params.event);
  try {
    await sendMessageFeishu({
      cfg: params.cfg,
      to: primaryTarget,
      text: `⚠️ ${reasonText}`,
      accountId: params.accountId,
    });
  } catch (err) {
    if (!isInvalidReceiveIdError(err)) {
      throw err;
    }

    const fallbackTarget = resolveUserCallbackTarget(params.event);
    if (fallbackTarget === primaryTarget) {
      throw err;
    }

    await sendMessageFeishu({
      cfg: params.cfg,
      to: fallbackTarget,
      text: `⚠️ ${reasonText}`,
      accountId: params.accountId,
    });
  }
}

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;
  if (!event.token.trim()) {
    log(
      `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: missing token`,
    );
    return;
  }
  const decoded = decodeFeishuCardAction({ event });
  const claimedToken = beginFeishuCardActionToken({
    token: event.token,
    accountId: account.accountId,
  });
  if (!claimedToken) {
    log(`feishu[${account.accountId}]: skipping duplicate card action token ${event.token}`);
    return;
  }

  try {
    if (decoded.kind === "invalid") {
      log(
        `feishu[${account.accountId}]: rejected card action from ${event.operator.open_id}: ${decoded.reason}`,
      );
      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: decoded.reason,
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    if (decoded.kind === "structured") {
      const { envelope } = decoded;
      log(
        `feishu[${account.accountId}]: handling structured card action ${envelope.a} from ${event.operator.open_id}`,
      );

      if (envelope.a === FEISHU_APPROVAL_REQUEST_ACTION) {
        const command = typeof envelope.m?.command === "string" ? envelope.m.command.trim() : "";
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        const prompt =
          typeof envelope.m?.prompt === "string" && envelope.m.prompt.trim()
            ? envelope.m.prompt
            : `Run \`${command}\` in this Feishu conversation?`;
        await sendCardFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          card: createApprovalCard({
            operatorOpenId: event.operator.open_id,
            chatId: event.context.chat_id || undefined,
            command,
            prompt,
            sessionKey: envelope.c?.s,
            expiresAt: Date.now() + FEISHU_APPROVAL_CARD_TTL_MS,
            chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
            confirmLabel: command === "/reset" ? "Reset" : "Confirm",
          }),
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_JWXT_LOGIN_SUBMIT_ACTION) {
        await handleFeishuJwxtLoginSubmit({
          cfg,
          accountId,
          runtime,
          event: {
            operator: {
              open_id: event.operator.open_id,
            },
            action: {
              form_value: event.action.form_value,
            },
            context: {
              chat_id: event.context.chat_id,
            },
          },
          envelopeMetadata: envelope.m,
          chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
          sessionKey: envelope.c?.s,
          onResumeMessage: async (messageText) =>
            await dispatchSyntheticCommand({
              cfg,
              event,
              command: messageText,
              botOpenId: params.botOpenId,
              runtime,
              accountId,
              chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
            }),
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_JWXT_LOGIN_REFRESH_ACTION) {
        await handleFeishuJwxtLoginRefresh({
          cfg,
          accountId,
          runtime,
          event,
          envelopeMetadata: envelope.m ?? {},
          chatType: envelope.c?.t,
          sessionKey: envelope.c?.s,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CANCEL_ACTION) {
        await sendMessageFeishu({
          cfg,
          to: resolveCallbackTarget(event),
          text: "Cancelled.",
          accountId,
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      if (envelope.a === FEISHU_APPROVAL_CONFIRM_ACTION || envelope.k === "quick") {
        const command = envelope.q?.trim();
        if (!command) {
          await sendInvalidInteractionNotice({
            cfg,
            event,
            reason: "malformed",
            accountId,
          });
          completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
          return;
        }
        await dispatchSyntheticCommand({
          cfg,
          event,
          command,
          botOpenId: params.botOpenId,
          runtime,
          accountId,
          chatType: envelope.c?.t ?? (event.context.chat_id ? "group" : "p2p"),
        });
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }

      await sendInvalidInteractionNotice({
        cfg,
        event,
        reason: "malformed",
        accountId,
      });
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
      return;
    }

    const content = buildFeishuCardActionTextFallback(event);

    if (isLikelyJwxtFormSubmitAction(event.action)) {
      log(
        `feishu[${account.accountId}]: handling form submit fallback without structured envelope from ${event.operator.open_id}`,
      );
      const fallbackMetadata = resolveFeishuJwxtLoginSubmitMetadataFallback({
        accountId: account.accountId,
        operatorOpenId: event.operator.open_id,
        chatId: event.context.chat_id,
      });
      const handled = await handleFeishuJwxtLoginSubmit({
        cfg,
        accountId,
        runtime,
        event: {
          operator: {
            open_id: event.operator.open_id,
          },
          action: {
            form_value: event.action.form_value,
          },
          context: {
            chat_id: event.context.chat_id,
          },
        },
        envelopeMetadata: fallbackMetadata,
        chatType: event.context.chat_id ? "group" : "p2p",
        onResumeMessage: async (messageText) =>
          await dispatchSyntheticCommand({
            cfg,
            event,
            command: messageText,
            botOpenId: params.botOpenId,
            runtime,
            accountId,
            chatType: event.context.chat_id ? "group" : "p2p",
          }),
      });
      if (handled) {
        completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
        return;
      }
    }

    log(
      `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
    );

    await dispatchSyntheticCommand({
      cfg,
      event,
      command: content,
      botOpenId: params.botOpenId,
      runtime,
      accountId,
    });
    completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
  } catch (err) {
    if (err instanceof FeishuRetryableCardActionError) {
      releaseFeishuCardActionToken({ token: event.token, accountId: account.accountId });
    } else {
      completeFeishuCardActionToken({ token: event.token, accountId: account.accountId });
    }
    throw err;
  }
}
