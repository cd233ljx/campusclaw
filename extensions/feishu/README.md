# Feishu Extension

This extension wires Feishu inbound events, card actions, and outbound replies.

## JWXT Login Flow Integration (GDUFE)

The chat-in-card JWXT login flow is implemented in:

1. `src/jwxt-login-flow.ts`
2. `src/card-action.ts`
3. `src/bot.ts`
4. `src/monitor.account.ts`

Behavior summary:

1. On JWXT-like intent, OpenClaw calls `start` and can send a captcha card.
2. On card submit (`feishu.jwxt.login.submit`), OpenClaw calls `submit`.
3. On successful submit, OpenClaw posts the replay summary back to the same chat.

## Config

Add this to `channels.feishu`:

```json
{
  "jwxtLoginFlow": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:5001",
    "startPath": "/channel/feishu/jwxt/login/start",
    "submitPath": "/channel/feishu/jwxt/login/submit",
    "tenantKey": "default",
    "authHeaderName": "Authorization",
    "authHeader": "Bearer <your-internal-token>",
    "keywordPatterns": ["成绩", "课表", "学分", "教务"],
    "defaultToolName": "jwxt.get_grades",
    "timeoutMs": 15000
  }
}
```

## Local Integration Test

Run against the local Flask stub server:

1. Start backend stub:

```bash
cd /home/cd233/CODE/gdufe-campus-agent-mcp/flask-api
.venv/bin/python tests/e2e_feishu_jwxt_stub_server.py
```

2. Run Feishu local integration test:

```bash
cd /home/cd233/CODE/campusclaw
OPENCLAW_FEISHU_JWXT_E2E=1 \
OPENCLAW_E2E_JWXT_BASE_URL=http://127.0.0.1:5111 \
node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.extension-feishu.config.ts \
  extensions/feishu/src/jwxt-login-flow.local-integration.test.ts \
  --reporter=verbose
```

Expected logs include:

1. `[E2E][start][metadata] ...`
2. `[E2E][submit][reply] 登录成功，已自动继续执行之前的查询 ...`
