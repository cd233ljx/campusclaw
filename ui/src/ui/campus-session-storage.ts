import { getSafeLocalStorage } from "../local-storage.ts";
import { normalizeOptionalString } from "./string-coerce.ts";

const GDUFE_API_BASE_STORAGE_KEY = "openclaw.gdufe.apiBaseUrl.v1";
const JWXT_SESSION_ID_STORAGE_KEY = "openclaw.gdufe.jwxtSessionId.v1";
const SECOND_CLASS_SESSION_ID_STORAGE_KEY = "openclaw.gdufe.secondClassSessionId.v1";

type CampusSessionStorageKey = "jwxt" | "secondClass";

function resolveStorageKey(kind: CampusSessionStorageKey): string {
  return kind === "jwxt" ? JWXT_SESSION_ID_STORAGE_KEY : SECOND_CLASS_SESSION_ID_STORAGE_KEY;
}

function loadStoredSessionId(kind: CampusSessionStorageKey): string | undefined {
  const value = getSafeLocalStorage()?.getItem(resolveStorageKey(kind));
  return normalizeOptionalString(value) ?? undefined;
}

function normalizeApiBaseUrl(value: string | undefined): string | undefined {
  return normalizeOptionalString(value)?.replace(/\/$/, "") ?? undefined;
}

function loadStoredCampusApiBaseUrl(): string | undefined {
  return normalizeApiBaseUrl(
    getSafeLocalStorage()?.getItem(GDUFE_API_BASE_STORAGE_KEY) ?? undefined,
  );
}

function storeCampusApiBaseUrl(baseUrl?: string): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  const normalized = normalizeApiBaseUrl(baseUrl);
  if (normalized) {
    storage.setItem(GDUFE_API_BASE_STORAGE_KEY, normalized);
    return;
  }
  storage.removeItem(GDUFE_API_BASE_STORAGE_KEY);
}

function storeSessionId(kind: CampusSessionStorageKey, sessionId?: string): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  const normalized = normalizeOptionalString(sessionId);
  const key = resolveStorageKey(kind);
  if (normalized) {
    storage.setItem(key, normalized);
    return;
  }
  storage.removeItem(key);
}

export function loadCampusSessionSendParams(): {
  jwxtSessionId?: string;
  secondClassSessionId?: string;
} {
  const jwxtSessionId = loadStoredSessionId("jwxt");
  const secondClassSessionId = loadStoredSessionId("secondClass");
  return {
    ...(jwxtSessionId ? { jwxtSessionId } : {}),
    ...(secondClassSessionId ? { secondClassSessionId } : {}),
  };
}

function deriveDefaultApiBaseUrl(): string {
  if (typeof window === "undefined") {
    return "http://127.0.0.1:5001";
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const host = window.location.hostname || "127.0.0.1";
  return `${protocol}//${host}:5001`;
}

function loadCampusApiBaseUrl(): string {
  return loadStoredCampusApiBaseUrl() ?? deriveDefaultApiBaseUrl();
}

function listCampusApiBaseUrls(): string[] {
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "https:" ? "https:" : "http:";
  const host =
    typeof window !== "undefined" ? normalizeOptionalString(window.location.hostname) : undefined;
  const seen = new Set<string>();
  const candidates = [
    loadStoredCampusApiBaseUrl(),
    deriveDefaultApiBaseUrl(),
    host === "localhost" ? `${protocol}//127.0.0.1:5001` : undefined,
    host === "127.0.0.1" ? `${protocol}//localhost:5001` : undefined,
  ];
  return candidates.filter((candidate): candidate is string => {
    const normalized = normalizeApiBaseUrl(candidate);
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

type CampusStatusResponse = {
  baseUrl: string;
  payload: Record<string, unknown>;
};

async function requestCampusStatus(path: string): Promise<CampusStatusResponse | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  let fallbackResult: CampusStatusResponse | null = null;
  for (const baseUrl of listCampusApiBaseUrls()) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "include",
        mode: "cors",
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const result = { baseUrl, payload };
      if (payload.loggedIn === true) {
        storeCampusApiBaseUrl(baseUrl);
        return result;
      }
      fallbackResult ??= result;
    } catch {
      continue;
    }
  }
  return fallbackResult;
}

function shouldClearStoredSession(baseUrl: string): boolean {
  const preferredBaseUrl = loadCampusApiBaseUrl();
  return normalizeApiBaseUrl(preferredBaseUrl) === normalizeApiBaseUrl(baseUrl);
}

export async function resolveCampusSessionSendParams(): Promise<{
  jwxtSessionId?: string;
  secondClassSessionId?: string;
}> {
  let params = loadCampusSessionSendParams();
  const jwxtStatus = await requestCampusStatus("/api/jwxt/status");
  if (jwxtStatus) {
    const loggedIn = jwxtStatus.payload.loggedIn === true;
    const sessionId =
      typeof jwxtStatus.payload.sessionId === "string"
        ? normalizeOptionalString(jwxtStatus.payload.sessionId)
        : undefined;
    if (loggedIn && sessionId) {
      storeCampusApiBaseUrl(jwxtStatus.baseUrl);
      storeJwxtSessionId(sessionId);
      params = {
        ...params,
        jwxtSessionId: sessionId,
      };
    } else if (!loggedIn && shouldClearStoredSession(jwxtStatus.baseUrl)) {
      clearJwxtSessionId();
      const { jwxtSessionId: _discarded, ...rest } = params;
      params = rest;
    }
  }
  const secondClassStatus = await requestCampusStatus("/api/second-class/status");
  if (secondClassStatus) {
    const loggedIn = secondClassStatus.payload.loggedIn === true;
    const sessionId =
      typeof secondClassStatus.payload.sessionId === "string"
        ? normalizeOptionalString(secondClassStatus.payload.sessionId)
        : undefined;
    if (loggedIn && sessionId) {
      storeCampusApiBaseUrl(secondClassStatus.baseUrl);
      storeSecondClassSessionId(sessionId);
      params = {
        ...params,
        secondClassSessionId: sessionId,
      };
    } else if (!loggedIn && shouldClearStoredSession(secondClassStatus.baseUrl)) {
      clearSecondClassSessionId();
      const { secondClassSessionId: _discarded, ...rest } = params;
      params = rest;
    }
  }
  return params;
}

export function storeJwxtSessionId(sessionId?: string): void {
  storeSessionId("jwxt", sessionId);
}

export function clearJwxtSessionId(): void {
  storeSessionId("jwxt");
}

export function storeSecondClassSessionId(sessionId?: string): void {
  storeSessionId("secondClass", sessionId);
}

export function clearSecondClassSessionId(): void {
  storeSessionId("secondClass");
}
