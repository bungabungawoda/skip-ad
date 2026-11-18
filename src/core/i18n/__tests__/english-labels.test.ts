import { afterEach, describe, expect, it, vi } from "vitest";

describe("English interface labels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("switches shared labels when the browser UI language is not Chinese", async () => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "en-US" }
    });
    const { kindLabel } = await import("../../policy/kinds");
    const { policyText } = await import("../../ui/kinds");
    const { humanError } = await import("../../../entrypoints/options/connection-errors");

    expect(kindLabel("sponsor")).toBe("Sponsorship");
    expect(policyText("auto")).toBe("Auto-skip");
    expect(humanError({ kind: "auth" })).toBe(
      "This key does not work. Check that you copied all of it."
    );
  });
});
