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

import {
  handleFeishuJwxtLoginRefresh,
  handleFeishuJwxtLoginSubmit,
  maybeStartFeishuJwxtLoginFlow,
} from "./jwxt-login-flow.js";

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
          keywordPatterns: ["成绩"],
          defaultToolName: "jwxt.get_grades",
          timeoutMs: 15000,
        },
      },
    },
  } as unknown as ClawdbotConfig;
}

function findCardNodeByTag(node: unknown, tag: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findCardNodeByTag(item, tag);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof node !== "object" || node === null) {
    return null;
  }

  const record = node as Record<string, unknown>;
  if (record.tag === tag) {
    return record;
  }

  for (const value of Object.values(record)) {
    const found = findCardNodeByTag(value, tag);
    if (found) {
      return found;
    }
  }

  return null;
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

describe("Feishu JWXT login flow unit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadImageFeishuMock.mockResolvedValue({ imageKey: "img_unit_captcha" });
    editMessageFeishuMock.mockResolvedValue({
      messageId: "om_card_unit",
      contentType: "interactive",
    });
    sendCardFeishuMock.mockResolvedValue({ messageId: "om_card_unit", chatId: "oc_group_unit" });
    sendMessageFeishuMock.mockResolvedValue({
      messageId: "om_msg_unit",
      chatId: "oc_group_unit",
    });
    sendMarkdownCardFeishuMock.mockResolvedValue({
      messageId: "om_md_card_unit",
      chatId: "oc_group_unit",
    });
    vi.restoreAllMocks();
  });

  it("normalizes seconds-based expire_at to milliseconds", async () => {
    const nowMs = 1_800_000_000_000;
    const expireAtSeconds = Math.floor((nowMs + 120_000) / 1000);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          need_login: true,
          card_payload: {
            title: "教务系统登录已过期",
            description: "请重新登录",
            captcha: {
              image_base64: "aGVsbG8=",
            },
            hidden: {
              login_ticket: "ticket-seconds",
              user_id: "ou_user_unit",
              channel: "feishu",
              tenant_key: "default",
            },
            submit: {
              label: "登录并继续查询",
            },
            expire_at: expireAtSeconds,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "帮我查成绩",
    });

    expect(started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    const formContainer = findCardNodeByTag(sentCard, "form");
    const buttons = findAllCardNodesByTag(formContainer, "button");
    const submitButton = buttons.find((button) => button.name === "jwxt_login_submit") ?? null;
    const refreshButton = buttons.find((button) => button.name === "jwxt_login_refresh") ?? null;
    const embeddedExpireAt =
      (submitButton?.value as { c?: { e?: number } } | undefined)?.c?.e ?? undefined;
    const callbackBehavior =
      (
        submitButton?.behaviors as Array<{ type?: string; value?: { oc?: string } }> | undefined
      )?.[0] ?? undefined;

    expect(formContainer?.name).toBe("jwxt_login_form");
    expect(submitButton?.form_action_type).toBe("submit");
    expect(submitButton?.name).toBe("jwxt_login_submit");
    expect(refreshButton?.name).toBe("jwxt_login_refresh");
    expect(refreshButton?.form_action_type).toBeUndefined();
    expect((refreshButton?.value as { a?: string } | undefined)?.a).toBe(
      "feishu.jwxt.login.refresh",
    );
    expect(callbackBehavior?.type).toBe("callback");
    expect(callbackBehavior?.value?.oc).toBe("ocf1");
    expect(typeof embeddedExpireAt).toBe("number");
    expect((embeddedExpireAt ?? 0) > nowMs).toBe(true);
    expect(embeddedExpireAt).toBe(expireAtSeconds * 1000);
  });

  it("parses ISO expire_at strings without numeric truncation", async () => {
    const nowMs = Date.parse("2026-04-17T12:42:00Z");
    const expireAtIso = "2026-04-17T12:47:00+00:00";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          need_login: true,
          card_payload: {
            title: "教务系统登录已过期",
            description: "请重新登录",
            captcha: {
              image_base64: "aGVsbG8=",
            },
            hidden: {
              login_ticket: "ticket-iso",
              user_id: "ou_user_unit",
              channel: "feishu",
              tenant_key: "default",
            },
            submit: {
              label: "登录并继续查询",
            },
            expire_at: expireAtIso,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "帮我查成绩",
    });

    expect(started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    const submitButton =
      findAllCardNodesByTag(sentCard, "button").find(
        (button) => button.name === "jwxt_login_submit",
      ) ?? null;
    const embeddedExpireAt =
      (submitButton?.value as { c?: { e?: number } } | undefined)?.c?.e ?? undefined;

    expect(typeof embeddedExpireAt).toBe("number");
    expect((embeddedExpireAt ?? 0) > nowMs).toBe(true);
    expect(embeddedExpireAt).toBe(Date.parse(expireAtIso));
  });

  it("triggers jwxt kickoff for fallback intent hints even when not in configured keywordPatterns", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          need_login: true,
          card_payload: {
            title: "教务系统登录已过期",
            description: "请重新登录",
            captcha: {
              image_base64: "aGVsbG8=",
            },
            hidden: {
              login_ticket: "ticket-fallback-hint",
              user_id: "ou_user_unit",
              channel: "feishu",
              tenant_key: "default",
            },
            submit: {
              label: "登录并继续查询",
            },
            expire_at: Date.now() + 120_000,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "帮我看下 gpa",
    });

    expect(started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("triggers jwxt kickoff for natural schedule phrasing without explicit '课表'", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          need_login: true,
          card_payload: {
            title: "教务系统登录已过期",
            description: "请重新登录",
            captcha: {
              image_base64: "aGVsbG8=",
            },
            hidden: {
              login_ticket: "ticket-natural-schedule",
              user_id: "ou_user_unit",
              channel: "feishu",
              tenant_key: "default",
            },
            submit: {
              label: "登录并继续查询",
            },
            expire_at: Date.now() + 120_000,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "查下我下周 的课",
    });

    expect(started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);

    const requestInit = fetchMock.mock.calls[0]?.[1];
    const requestBody =
      typeof requestInit?.body === "string"
        ? JSON.parse(requestInit.body)
        : (requestInit?.body as Record<string, unknown> | undefined);
    expect(requestBody?.tool_name).toBe("jwxt.get_schedule");
  });

  it("does not trigger jwxt kickoff for course recommendation utterances", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "推荐学分高的课程",
    });

    expect(started).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("triggers kickoff for second-class credit utterances", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          need_login: true,
          card_payload: {
            title: "校园系统登录已过期",
            description: "请重新登录",
            captcha: {
              image_base64: "aGVsbG8=",
            },
            hidden: {
              login_ticket: "ticket-second-class",
              user_id: "ou_user_unit",
              channel: "feishu",
              tenant_key: "default",
            },
            submit: {
              label: "登录并继续查询",
            },
            expire_at: Date.now() + 120_000,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const cfg = buildConfig("http://127.0.0.1:5111");
    const feishuCfg = (cfg.channels?.feishu ?? {}) as {
      jwxtLoginFlow?: {
        keywordPatterns?: string[];
      };
    };
    if (feishuCfg.jwxtLoginFlow) {
      feishuCfg.jwxtLoginFlow.keywordPatterns = ["成绩", "学分"];
    }

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg,
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "帮我查询第二课堂学分",
    });

    expect(started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    const requestInit = fetchMock.mock.calls[0]?.[1];
    const requestBody =
      typeof requestInit?.body === "string"
        ? JSON.parse(requestInit.body)
        : (requestInit?.body as Record<string, unknown> | undefined);
    expect(requestBody?.tool_name).toBe("second_class.get_credit_summary");
  });

  it("falls through to normal dispatch when start response asks to pass through", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          need_login: false,
          pass_through: true,
          user_message: "会话有效，继续正常处理",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "帮我查成绩",
    });

    expect(started).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("handles non-login upstream message inline without falling through", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          need_login: false,
          user_message: "教务系统暂时维护中，请稍后再试。",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const started = await maybeStartFeishuJwxtLoginFlow({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      operatorOpenId: "ou_user_unit",
      chatId: "oc_group_unit",
      chatType: "group",
      messageText: "帮我查成绩",
    });

    expect(started).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    const sentText = String(sendMessageFeishuMock.mock.calls[0]?.[0]?.text ?? "");
    expect(sentText).toContain("教务系统暂时维护中");
  });

  it("refreshes captcha card on explicit refresh action", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "验证码已刷新，请使用新卡片继续登录",
          card_payload: {
            title: "校园系统登录已过期",
            description: "请重新输入验证码",
            captcha: {
              image_base64: "aGVsbG8=",
            },
            hidden: {
              login_ticket: "ticket-refresh-unit",
              user_id: "ou_user_unit",
              channel: "feishu",
              tenant_key: "default",
            },
            refresh: {
              label: "刷新验证码",
            },
            submit: {
              label: "登录并继续查询",
            },
            expire_at: Date.now() + 120_000,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginRefresh({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-refresh-unit",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:5111/channel/feishu/jwxt/login/refresh",
    );
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("edits the original captcha card in place when refresh action includes message_id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "验证码已刷新，请使用新卡片继续登录",
          card_payload: {
            title: "校园系统登录已过期",
            description: "请重新输入验证码",
            captcha: {
              image_base64: "aGVsbG8=",
            },
            hidden: {
              login_ticket: "ticket-refresh-edit-unit",
              user_id: "ou_user_unit",
              channel: "feishu",
              tenant_key: "default",
            },
            refresh: {
              label: "刷新验证码",
            },
            submit: {
              label: "登录并继续查询",
            },
            expire_at: Date.now() + 120_000,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginRefresh({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        context: {
          chat_id: "oc_group_unit",
          message_id: "om_existing_login_card",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-refresh-edit-unit",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(editMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(editMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_existing_login_card",
        accountId: "default",
      }),
    );
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("accepts wrapped and aliased form_value fields on submit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "登录成功，正在继续查询。",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginSubmit({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        action: {
          form_value: {
            student_input: ["20210001"],
            pwd_value: { value: "password-demo" },
            captcha_field: { text: "ABCD" },
          },
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-submit-unit",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const requestBodyRaw = init?.body;
    const requestBody = JSON.parse(
      typeof requestBodyRaw === "string" ? requestBodyRaw : "{}",
    ) as Record<string, unknown>;

    expect(requestBody.student_id).toBe("20210001");
    expect(requestBody.password).toBe("password-demo");
    expect(requestBody.captcha_code).toBe("ABCD");
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "登录成功，正在继续查询。",
      }),
    );
  });

  it("resumes the original question through callback after successful login", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "登录成功，正在继续处理刚才的问题",
          resume_via_agent: true,
          resume_message_text: "帮我查询第二课堂学分",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onResumeMessage = vi.fn(async () => {});

    const handled = await handleFeishuJwxtLoginSubmit({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        action: {
          form_value: {
            student_id: "20210001",
            password: "password-demo",
            captcha_code: "ABCD",
          },
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-submit-unit-resume",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
      onResumeMessage,
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "登录成功，正在继续处理刚才的问题，请稍候 1-2 秒。",
      }),
    );
    expect(onResumeMessage).toHaveBeenCalledWith("帮我查询第二课堂学分");
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("formats jwxt grade replay as table card instead of JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "登录成功，正在继续查询。",
          replay_result: {
            success: true,
            tool: "jwxt.get_grades",
            data: {
              count: 1,
              grades: [
                {
                  semester: "2024-2025-1",
                  courseName: "高等数学 I",
                  credit: "6",
                  score: "100",
                  examType: "考试",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginSubmit({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        action: {
          form_value: {
            student_id: "20210001",
            password: "password-demo",
            captcha_code: "ABCD",
          },
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-submit-unit-table",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    const summaryNode = findCardNodeByTag(sentCard, "markdown");
    const tableNode = findCardNodeByTag(sentCard, "table");
    const rows = Array.isArray(tableNode?.rows)
      ? (tableNode.rows as Array<Record<string, unknown>>)
      : [];

    expect(typeof summaryNode?.content === "string" ? summaryNode.content : "").toContain(
      "已自动继续查询（jwxt.get_grades），共 1 门",
    );
    expect(rows.length).toBe(1);
    expect(typeof rows[0]?.course === "string" ? rows[0].course : "").toContain("高等数学 I");
    expect(typeof rows[0]?.score === "string" ? rows[0].score : "").toContain("100");
  });

  it("prefers structured jwxt table card when grade rows exist", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "登录成功，正在继续查询。",
          replay_result: {
            success: true,
            tool: "jwxt.get_grades",
            data: {
              textResult: "### 成绩结果\n\n1. 高等数学 I：100\n2. 大学英语 III：90",
              count: 2,
              grades: [
                {
                  semester: "2024-2025-1",
                  courseName: "高等数学 I",
                  credit: "6",
                  score: "100",
                  examType: "考试",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginSubmit({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        action: {
          form_value: {
            student_id: "20210001",
            password: "password-demo",
            captcha_code: "ABCD",
          },
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-submit-unit-text-result",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    const summaryNode = findCardNodeByTag(sentCard, "markdown");
    const tableNode = findCardNodeByTag(sentCard, "table");
    const rows = Array.isArray(tableNode?.rows)
      ? (tableNode.rows as Array<Record<string, unknown>>)
      : [];

    expect(typeof summaryNode?.content === "string" ? summaryNode.content : "").toContain(
      "已自动继续查询（jwxt.get_grades）",
    );
    expect(typeof summaryNode?.content === "string" ? summaryNode.content : "").not.toContain(
      "### 成绩结果",
    );
    expect(rows.length).toBe(1);
    expect(typeof rows[0]?.course === "string" ? rows[0].course : "").toContain("高等数学 I");
  });

  it("formats jwxt schedule replay as table and excludes raw html", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "登录成功，正在继续查询。",
          replay_result: {
            success: true,
            tool: "jwxt.get_schedule",
            data: {
              courseCount: 1,
              structured: [
                {
                  weekDay: "星期一",
                  timeSlot: "第一二节",
                  name: "数据结构",
                  location: "慎思楼401",
                  teacher: "张老师",
                  weeks: "1-16周",
                },
              ],
              rawHtml: "<html><body>huge html payload</body></html>",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginSubmit({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        action: {
          form_value: {
            student_id: "20210001",
            password: "password-demo",
            captcha_code: "ABCD",
          },
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-submit-unit-schedule",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    const summaryNode = findCardNodeByTag(sentCard, "markdown");
    const tableNode = findCardNodeByTag(sentCard, "table");
    const rows = Array.isArray(tableNode?.rows)
      ? (tableNode.rows as Array<Record<string, unknown>>)
      : [];

    expect(typeof summaryNode?.content === "string" ? summaryNode.content : "").toContain(
      "已自动继续查询（jwxt.get_schedule）",
    );
    expect(typeof summaryNode?.content === "string" ? summaryNode.content : "").not.toContain(
      "rawHtml",
    );
    expect(rows.length).toBe(1);
    expect(typeof rows[0]?.course === "string" ? rows[0].course : "").toContain("数据结构");
    expect(typeof rows[0]?.location === "string" ? rows[0].location : "").toContain("慎思楼401");
  });

  it("reuses Flask markdown textResult for course recommendations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "登录成功，正在继续查询。",
          replay_result: {
            success: true,
            tool: "course.recommend",
            data: {
              textResult: "### 课程推荐\n\n1. **算法设计**（3学分）\n2. **数据库系统**（3学分）",
              totalFound: 2,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginSubmit({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        action: {
          form_value: {
            student_id: "20210001",
            password: "password-demo",
            captcha_code: "ABCD",
          },
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-submit-unit-course",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    const sentText = String(sendMarkdownCardFeishuMock.mock.calls[0]?.[0]?.text ?? "");
    expect(sentText).toContain("已自动继续查询（course.recommend）");
    expect(sentText).toContain("### 课程推荐");
    expect(sentText).toContain("**算法设计**");
    expect(sentText).not.toContain("- textResult：");
  });

  it("reuses backend textSummary for second-class replay instead of dumping raw fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          user_message: "会话有效，已直接返回查询结果。",
          replay_result: {
            success: true,
            tool: "second_class.get_credit_summary",
            data: {
              categories: [{ categoryName: "思想引领" }],
              rawCategories: [{ classifyName: "思想引领" }],
              studentId: "24251102114",
              textSummary:
                "你好，赖晋希同学！这是你的第二课堂学分概览：\n总分：8.50 / 10.00（还差 1.50 分）\n已达标项目：文体艺术、志愿公益、技能培训",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const handled = await handleFeishuJwxtLoginSubmit({
      cfg: buildConfig("http://127.0.0.1:5111"),
      accountId: "default",
      event: {
        operator: {
          open_id: "ou_user_unit",
        },
        action: {
          form_value: {
            student_id: "20210001",
            password: "password-demo",
            captcha_code: "ABCD",
          },
        },
        context: {
          chat_id: "oc_group_unit",
        },
      },
      envelopeMetadata: {
        login_ticket: "ticket-submit-unit-second-class",
        user_id: "ou_user_unit",
        channel: "feishu",
        tenant_key: "default",
      },
      chatType: "group",
      sessionKey: "session-unit",
    });

    expect(handled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    const sentText = String(sendMarkdownCardFeishuMock.mock.calls[0]?.[0]?.text ?? "");
    expect(sentText).toContain("已自动继续查询（second_class.get_credit_summary）");
    expect(sentText).toContain("你好，赖晋希同学");
    expect(sentText).not.toContain("categories：共 1 项");
    expect(sentText).not.toContain("rawCategories：共 1 项");
    expect(sentText).not.toContain("studentId：24251102114");
  });
});
