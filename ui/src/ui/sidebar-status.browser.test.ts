import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("sidebar connection status", () => {
  it("shows advanced-settings toggle with a disabled status dot by default", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const version = app.querySelector<HTMLElement>(".sidebar-version--toggle");
    const statusDot = app.querySelector<HTMLElement>(".sidebar-version__status");
    expect(version).not.toBeNull();
    expect(statusDot).not.toBeNull();
    expect(statusDot?.classList.contains("sidebar-version__status--disabled")).toBe(true);
  });
});
