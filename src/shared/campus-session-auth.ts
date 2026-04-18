import { normalizeOptionalString } from "./string-coerce.js";

export type CampusSessionHeaders = {
  "X-JWXT-Session-ID"?: string;
  "X-Second-Class-Session-ID"?: string;
};

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const parsed: Record<string, string> = {};
  const normalizedHeader = normalizeOptionalString(cookieHeader);
  if (!normalizedHeader) {
    return parsed;
  }
  for (const entry of normalizedHeader.split(";")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = entry.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }
    const value = entry.slice(separatorIndex + 1).trim();
    parsed[key] = decodeCookieValue(value);
  }
  return parsed;
}

export function buildCampusSessionHeaders(params: {
  jwxtSessionId?: string;
  secondClassSessionId?: string;
}): CampusSessionHeaders | undefined {
  const jwxtSessionId = normalizeOptionalString(params.jwxtSessionId);
  const secondClassSessionId = normalizeOptionalString(params.secondClassSessionId);
  if (!jwxtSessionId && !secondClassSessionId) {
    return undefined;
  }
  return {
    ...(jwxtSessionId ? { "X-JWXT-Session-ID": jwxtSessionId } : {}),
    ...(secondClassSessionId ? { "X-Second-Class-Session-ID": secondClassSessionId } : {}),
  };
}

export function buildCampusSessionHeadersFromCookieHeader(
  cookieHeader: string | undefined,
): CampusSessionHeaders | undefined {
  const cookies = parseCookieHeader(cookieHeader);
  return buildCampusSessionHeaders({
    jwxtSessionId: cookies.jwxt_session_id,
    secondClassSessionId: cookies.second_class_session_id,
  });
}

export function createCampusSessionHeadersFingerprint(
  headers: CampusSessionHeaders | undefined,
): string {
  return JSON.stringify({
    jwxt: normalizeOptionalString(headers?.["X-JWXT-Session-ID"]) ?? "",
    secondClass: normalizeOptionalString(headers?.["X-Second-Class-Session-ID"]) ?? "",
  });
}

export function mergeCampusSessionHeaders(
  ...headersList: Array<CampusSessionHeaders | undefined>
): CampusSessionHeaders | undefined {
  let merged: CampusSessionHeaders = {};
  for (const headers of headersList) {
    if (!headers) {
      continue;
    }
    Object.assign(merged, headers);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
