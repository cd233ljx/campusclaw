import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const uploadImageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  uploadImageFeishu: uploadImageFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));

import { handleFeishuJwxtLoginSubmit, maybeStartFeishuJwxtLoginFlow } from "./jwxt-login-flow.js";

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

describe("Feishu JWXT login flow unit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadImageFeishuMock.mockResolvedValue({ imageKey: "img_unit_captcha" });
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
    const submitButton = findCardNodeByTag(formContainer, "button");
    const embeddedExpireAt =
      (submitButton?.value as { c?: { e?: number } } | undefined)?.c?.e ?? undefined;
    const callbackBehavior =
      (
        submitButton?.behaviors as Array<{ type?: string; value?: { oc?: string } }> | undefined
      )?.[0] ?? undefined;

    expect(formContainer?.name).toBe("jwxt_login_form");
    expect(submitButton?.form_action_type).toBe("submit");
    expect(submitButton?.name).toBe("jwxt_login_submit");
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
    const submitButton = findCardNodeByTag(sentCard, "button");
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

  it("does not trigger jwxt kickoff for second-class credit utterances", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
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

    expect(started).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("handles active-session start response inline without falling through to normal dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          need_login: false,
          user_message: "会话有效，已直接返回查询结果",
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
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();

    const sentCard = sendCardFeishuMock.mock.calls[0]?.[0]?.card;
    const summaryNode = findCardNodeByTag(sentCard, "markdown");
    const tableNode = findCardNodeByTag(sentCard, "table");
    const rows = Array.isArray(tableNode?.rows)
      ? (tableNode.rows as Array<Record<string, unknown>>)
      : [];

    expect(typeof summaryNode?.content === "string" ? summaryNode.content : "").toContain(
      "会话有效，已直接返回查询结果",
    );
    expect(rows.length).toBe(1);
    expect(typeof rows[0]?.course === "string" ? rows[0].course : "").toContain("高等数学 I");
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
});
