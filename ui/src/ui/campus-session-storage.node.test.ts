import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resolveCampusSessionSendParams } from "./campus-session-storage.ts";

const GDUFE_API_BASE_STORAGE_KEY = "openclaw.gdufe.apiBaseUrl.v1";
const JWXT_SESSION_ID_STORAGE_KEY = "openclaw.gdufe.jwxtSessionId.v1";

function setTestWindow(params?: { protocol?: string; hostname?: string }) {
  vi.stubGlobal("window", {
    location: {
      protocol: params?.protocol ?? "http:",
      hostname: params?.hostname ?? "localhost",
    },
  } as Window & typeof globalThis);
}

function createJsonResponse(payload: Record<string, unknown>, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

describe("resolveCampusSessionSendParams", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    setTestWindow();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the latest jwxt session from status even when local storage is stale", async () => {
    localStorage.setItem(GDUFE_API_BASE_STORAGE_KEY, "http://localhost:5001");
    localStorage.setItem(JWXT_SESSION_ID_STORAGE_KEY, "jwxt-stale-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "http://localhost:5001/api/jwxt/status") {
          return createJsonResponse({ loggedIn: true, sessionId: "jwxt-fresh-session" });
        }
        return createJsonResponse({ loggedIn: false });
      }),
    );

    await expect(resolveCampusSessionSendParams()).resolves.toEqual({
      jwxtSessionId: "jwxt-fresh-session",
    });
    expect(localStorage.getItem(JWXT_SESSION_ID_STORAGE_KEY)).toBe("jwxt-fresh-session");
    expect(localStorage.getItem(GDUFE_API_BASE_STORAGE_KEY)).toBe("http://localhost:5001");
  });

  it("falls back to the stored session when status probing is unavailable", async () => {
    localStorage.setItem(JWXT_SESSION_ID_STORAGE_KEY, "jwxt-cached-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network failed");
      }),
    );

    await expect(resolveCampusSessionSendParams()).resolves.toEqual({
      jwxtSessionId: "jwxt-cached-session",
    });
  });

  it("tries the loopback alias and stores the working api base url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url === "http://localhost:5001/api/jwxt/status") {
          return createJsonResponse({ loggedIn: false });
        }
        if (url === "http://127.0.0.1:5001/api/jwxt/status") {
          return createJsonResponse({ loggedIn: true, sessionId: "jwxt-alias-session" });
        }
        return createJsonResponse({ loggedIn: false });
      }),
    );

    await expect(resolveCampusSessionSendParams()).resolves.toEqual({
      jwxtSessionId: "jwxt-alias-session",
    });
    expect(localStorage.getItem(GDUFE_API_BASE_STORAGE_KEY)).toBe("http://127.0.0.1:5001");
  });

  it("clears the stored session when the preferred api base reports logged out", async () => {
    localStorage.setItem(GDUFE_API_BASE_STORAGE_KEY, "http://localhost:5001");
    localStorage.setItem(JWXT_SESSION_ID_STORAGE_KEY, "jwxt-stale-session");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createJsonResponse({ loggedIn: false })),
    );

    await expect(resolveCampusSessionSendParams()).resolves.toEqual({});
    expect(localStorage.getItem(JWXT_SESSION_ID_STORAGE_KEY)).toBeNull();
  });
});
