import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const uploadImageFeishuMock = vi.hoisted(() => vi.fn());
const editMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  uploadImageFeishu: uploadImageFeishuMock,
}));

vi.mock("./send.js", () => ({
  editMessageFeishu: editMessageFeishuMock,
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));

import { handleFeishuJwxtLoginSubmit, maybeStartFeishuJwxtLoginFlow } from "./jwxt-login-flow.js";

const E2E_ENABLED = process.env.OPENCLAW_FEISHU_JWXT_E2E === "1";
const E2E_BASE_URL = process.env.OPENCLAW_E2E_JWXT_BASE_URL ?? "http://127.0.0.1:5111";

function buildConfig(baseUrl: string): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        appId: "cli_test",
        appSecret: "secret_test",
        allowFrom: ["*"],
        jwxtLoginFlow: {
          enabled: true,
          baseUrl,
          startPath: "/channel/feishu/jwxt/login/start",
          refreshPath: "/channel/feishu/jwxt/login/refresh",
          submitPath: "/channel/feishu/jwxt/login/submit",
          tenantKey: "default",
          authHeaderName: "Authorization",
          authHeader: "Bearer bridge-token",
          keywordPatterns: ["成绩", "课表", "学分"],
          defaultToolName: "jwxt.get_grades",
          timeoutMs: 15000,
        },
      },
    },
  } as unknown as ClawdbotConfig;
}

function findAllCardNodesByTag(node: unknown, tag: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  function visit(current: unknown) {
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }

    if (typeof current !== "object" || current === null) {
      return;
    }

    const record = current as Record<string, unknown>;
    if (record.tag === tag) {
      results.push(record);
    }

    for (const value of Object.values(record)) {
      visit(value);
    }
  }

  visit(node);
  return results;
}

function getSubmitEnvelopeMetadata(card: unknown): Record<string, unknown> {
  const submitButton =
    findAllCardNodesByTag(card, "button").find((button) => button.name === "jwxt_login_submit") ??
    null;
  const directEnvelope = submitButton?.value as { m?: Record<string, unknown> } | undefined;
  const behaviorEnvelope =
    (
      submitButton?.behaviors as
        | Array<{ type?: string; value?: { m?: Record<string, unknown> } }>
        | undefined
    )?.find((behavior) => behavior?.type === "callback")?.value ?? undefined;
  const envelope = directEnvelope ?? behaviorEnvelope;
  return envelope?.m ?? {};
}

describe("Feishu JWXT login flow e2e", () => {
  const maybeIt = E2E_ENABLED ? it : it.skip;

  beforeEach(() => {
    vi.clearAllMocks();
    uploadImageFeishuMock.mockResolvedValue({ imageKey: "img_e2e_captcha" });
    editMessageFeishuMock.mockResolvedValue({
      messageId: "om_card_e2e",
      contentType: "interactive",
    });
    sendCardFeishuMock.mockResolvedValue({ messageId: "om_card_e2e", chatId: "oc_group_e2e" });
    sendMessageFeishuMock.mockResolvedValue({
      messageId: "om_msg_e2e",
      chatId: "oc_group_e2e",
    });
    sendMarkdownCardFeishuMock.mockResolvedValue({
      messageId: "om_md_card_e2e",
      chatId: "oc_group_e2e",
    });
  });

  maybeIt("drives start -> submit -> replay reply through live backend", async () => {
    const cfg = buildConfig(E2E_BASE_URL);
    const operatorOpenId = "ou_e2e_user_001";
    const chatId = "oc_e2e_group_001";

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg,
      accountId: "default",
      operatorOpenId,
      chatId,
      chatType: "group",
      messageText: "帮我查一下成绩",
    });

    expect(started).toBe(true);
    expect(uploadImageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    const metadata = getSubmitEnvelopeMetadata(sentCard);
    expect(typeof metadata.login_ticket).toBe("string");

    console.log("[E2E][start][metadata]", JSON.stringify(metadata));

    const onResumeMessage = vi.fn(async () => {});

    await handleFeishuJwxtLoginSubmit({
      cfg,
      accountId: "default",
      event: {
        operator: {
          open_id: operatorOpenId,
        },
        action: {
          form_value: {
            student_id: "20210001",
            password: "password-demo",
            captcha_code: "ABCD",
          },
        },
        context: {
          chat_id: chatId,
        },
      },
      envelopeMetadata: metadata,
      chatType: "group",
      onResumeMessage,
    });

    expect(onResumeMessage).toHaveBeenCalledTimes(1);
  });
});
