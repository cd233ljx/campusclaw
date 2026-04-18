import { describe, expect, it } from "vitest";
import {
  buildCampusSessionHeadersFromCookieHeader,
  createCampusSessionHeadersFingerprint,
  mergeCampusSessionHeaders,
} from "./campus-session-auth.js";

describe("campus session auth helpers", () => {
  it("parses campus session ids from cookie headers", () => {
    expect(
      buildCampusSessionHeadersFromCookieHeader(
        "foo=bar; jwxt_session_id=jwxt-123; second_class_session_id=second-456",
      ),
    ).toEqual({
      "X-JWXT-Session-ID": "jwxt-123",
      "X-Second-Class-Session-ID": "second-456",
    });
  });

  it("ignores blank or missing campus session cookies", () => {
    expect(
      buildCampusSessionHeadersFromCookieHeader("jwxt_session_id= ; second_class_session_id="),
    ).toBeUndefined();
    expect(buildCampusSessionHeadersFromCookieHeader(undefined)).toBeUndefined();
  });

  it("builds stable fingerprints and merges headers predictably", () => {
    const merged = mergeCampusSessionHeaders(
      { "X-JWXT-Session-ID": "jwxt-1" },
      { "X-Second-Class-Session-ID": "second-1" },
    );
    expect(merged).toEqual({
      "X-JWXT-Session-ID": "jwxt-1",
      "X-Second-Class-Session-ID": "second-1",
    });
    expect(createCampusSessionHeadersFingerprint(merged)).toBe(
      createCampusSessionHeadersFingerprint({
        "X-Second-Class-Session-ID": "second-1",
        "X-JWXT-Session-ID": "jwxt-1",
      }),
    );
  });
});
