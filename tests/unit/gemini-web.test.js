import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseGeminiAuthHtml,
  scrapeGeminiAuth,
  getGeminiAuth,
  clearGeminiAuthCache,
  GEMINI_FALLBACK_BL,
} from "../../open-sse/executors/gemini-web.js";

const originalFetch = global.fetch;

const SAMPLE_HTML_LOGGED_IN = `<script>window.WIZ_global_data = {"SNlM0e":"AXYZtokenvalue123","cfb2h":"boq_assistant-bard-web-server_20260728.05_p0","FdrFJe":"-1513666763805209402"};</script>`;

describe("parseGeminiAuthHtml", () => {
  it("extracts at (SNlM0e), bl (cfb2h) and sid (FdrFJe) from page HTML", () => {
    const parsed = parseGeminiAuthHtml(SAMPLE_HTML_LOGGED_IN, "https://gemini.google.com/app");
    expect(parsed.at).toBe("AXYZtokenvalue123");
    expect(parsed.bl).toBe("boq_assistant-bard-web-server_20260728.05_p0");
    expect(parsed.sid).toBe("-1513666763805209402");
    expect(parsed.redirectedToLogin).toBe(false);
  });

  it("falls back to GEMINI_FALLBACK_BL when cfb2h is missing", () => {
    const html = `<script>window.WIZ_global_data = {"SNlM0e":"tok"};</script>`;
    const parsed = parseGeminiAuthHtml(html, "https://gemini.google.com/app");
    expect(parsed.bl).toBe(GEMINI_FALLBACK_BL);
  });

  it("returns sid: null when FdrFJe is missing (session id is best-effort)", () => {
    const html = `<script>window.WIZ_global_data = {"SNlM0e":"tok","cfb2h":"bl-value"};</script>`;
    const parsed = parseGeminiAuthHtml(html, "https://gemini.google.com/app");
    expect(parsed.sid).toBeNull();
    expect(parsed.at).toBe("tok");
  });

  it("reports redirectedToLogin: true when redirected to accounts.google.com", () => {
    const parsed = parseGeminiAuthHtml(SAMPLE_HTML_LOGGED_IN, "https://accounts.google.com/signin/v2/identifier");
    expect(parsed.redirectedToLogin).toBe(true);
  });

  it("reports redirectedToLogin: false + at: null when the SNlM0e token is simply missing (soft condition, no redirect)", () => {
    const parsed = parseGeminiAuthHtml("<html><body>no token here</body></html>", "https://gemini.google.com/app");
    expect(parsed.redirectedToLogin).toBe(false);
    expect(parsed.at).toBeNull();
  });
});

describe("scrapeGeminiAuth", () => {
  it("sends the Cookie header verbatim and parses the HTML response", async () => {
    let capturedHeaders;
    const fetchImpl = vi.fn(async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        url: "https://gemini.google.com/app",
        text: async () => SAMPLE_HTML_LOGGED_IN,
      };
    });
    const auth = await scrapeGeminiAuth("cookie-fixture-abc", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://gemini.google.com/app", expect.objectContaining({
      headers: expect.objectContaining({ Cookie: "cookie-fixture-abc" }),
    }));
    expect(capturedHeaders.Cookie).toBe("cookie-fixture-abc");
    expect(auth.at).toBe("AXYZtokenvalue123");
    expect(auth.redirectedToLogin).toBe(false);
  });
});

describe("getGeminiAuth (cache)", () => {
  beforeEach(() => clearGeminiAuthCache());

  it("only scrapes once per connectionId within the TTL", async () => {
    const fetchImpl = vi.fn(async () => ({
      url: "https://gemini.google.com/app",
      text: async () => SAMPLE_HTML_LOGGED_IN,
    }));
    const first = await getGeminiAuth("conn-1", "cookie-fixture-abc", fetchImpl);
    const second = await getGeminiAuth("conn-1", "cookie-fixture-abc", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("scrapes independently per connectionId", async () => {
    const fetchImpl = vi.fn(async () => ({
      url: "https://gemini.google.com/app",
      text: async () => SAMPLE_HTML_LOGGED_IN,
    }));
    await getGeminiAuth("conn-a", "cookie-a", fetchImpl);
    await getGeminiAuth("conn-b", "cookie-b", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
