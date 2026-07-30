import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseGeminiAuthHtml,
  scrapeGeminiAuth,
  getGeminiAuth,
  clearGeminiAuthCache,
  GEMINI_FALLBACK_BL,
  parseGeminiModelList,
  fetchGeminiModelList,
  getGeminiModelList,
  clearGeminiModelCache,
  resolveGeminiModel,
  GEMINI_MODEL_SHORT_NAMES,
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

const SAMPLE_MODEL_LIST_FRAME =
  '[["wrb.fr","otAQ7b","' +
  JSON.stringify(JSON.stringify([
    1, [true, [1, 2, 3, 4, 5], true, [[null, [true], true]]], false, null, null, null, false,
    null, null, null, null, null, false, false, null,
    [
      ["56fdd199312815e2", "Flash", "All-around help", [2, 3], 2, null, [], true, "Flash3p6PaidV2Rollout", 20, "Flash", "3.6 Flash", "All-around help", null, null, true, "Flash3p6PaidV2Rollout", 1, ["icon-url", true], "3.6 Flash"],
      ["e051ce1aa80aa576", "Thinking", "Solves complex problems", [2, 3], 2, null, [], false, "", 15, "Thinking", "3.6 Thinking", "Solves complex problems", null, null, false, "", 5, ["icon-url", true], "3.6 Thinking"],
      ["e6fa609c3fa255c0", "Pro", "Advanced math & code", [2, 3], 2, null, [], false, "", 4, "Pro", "3.1 Pro", "Advanced math & code", null, null, false, "", 3, ["icon-url", true], "3.1 Pro"],
    ],
    [3, 0, 4, 5, 14, 38], [2, 3], "example.org", [], "", null, [true],
  ])).replace(/^"|"$/g, "") +
  '",null,null,null,"generic"]]\n' +
  '58\n' +
  '[["di",270],["af.httprm",269,"-3398175452093998264",43]]\n';

describe("parseGeminiModelList", () => {
  it("extracts hashId, shortName, displayName, mode and isDefault per model", () => {
    const models = parseGeminiModelList(SAMPLE_MODEL_LIST_FRAME);
    expect(models).toEqual([
      { hashId: "56fdd199312815e2", shortName: "Flash", displayName: "3.6 Flash", mode: 1, isDefault: true },
      { hashId: "e051ce1aa80aa576", shortName: "Thinking", displayName: "3.6 Thinking", mode: 5, isDefault: false },
      { hashId: "e6fa609c3fa255c0", shortName: "Pro", displayName: "3.1 Pro", mode: 3, isDefault: false },
    ]);
  });

  it("returns an empty array when the response has no otAQ7b frame", () => {
    expect(parseGeminiModelList('[["di",270]]')).toEqual([]);
  });
});

describe("resolveGeminiModel", () => {
  const models = [
    { hashId: "56fdd199312815e2", shortName: "Flash", displayName: "3.6 Flash", mode: 1, isDefault: true },
    { hashId: "e051ce1aa80aa576", shortName: "Thinking", displayName: "3.6 Thinking", mode: 5, isDefault: false },
    { hashId: "e6fa609c3fa255c0", shortName: "Pro", displayName: "3.1 Pro", mode: 3, isDefault: false },
  ];

  it("resolves gemini-web-thinking to the Thinking model's mode", () => {
    const resolved = resolveGeminiModel("gemini-web-thinking", models);
    expect(resolved).toEqual({ mode: 5, think: 4, hashId: "e051ce1aa80aa576", displayName: "3.6 Thinking" });
  });

  it("resolves a raw shortName or hashId (passthrough)", () => {
    expect(resolveGeminiModel("Pro", models).mode).toBe(3);
    expect(resolveGeminiModel("e6fa609c3fa255c0", models).mode).toBe(3);
  });

  it("falls back to the isDefault model when the requested model isn't in the account's list", () => {
    const resolved = resolveGeminiModel("gemini-web-pro", [models[1]]); // account has no Pro
    expect(resolved.hashId).toBe("e051ce1aa80aa576"); // only entry present, used as fallback
  });

  it("falls back to the first isDefault:true entry when nothing matches and multiple models exist", () => {
    const resolved = resolveGeminiModel("not-a-real-model", models);
    expect(resolved.hashId).toBe("56fdd199312815e2");
  });

  it("returns a synthetic no-op model when modelList is empty", () => {
    const resolved = resolveGeminiModel("gemini-web-flash", []);
    expect(resolved).toEqual({ mode: 1, think: 4, hashId: null, displayName: "gemini-web-flash" });
  });
});

describe("fetchGeminiModelList / getGeminiModelList", () => {
  beforeEach(() => clearGeminiModelCache());

  it("posts the otAQ7b RPC with at/bl/f.sid and parses the response", async () => {
    let capturedUrl, capturedBody;
    const fetchImpl = vi.fn(async (url, opts) => {
      capturedUrl = url;
      capturedBody = opts.body;
      return { text: async () => SAMPLE_MODEL_LIST_FRAME };
    });
    const models = await fetchGeminiModelList({ at: "tok", bl: "bl-val", sid: "sid-val" }, fetchImpl);
    expect(capturedUrl).toContain("rpcids=otAQ7b");
    expect(capturedUrl).toContain("bl=bl-val");
    expect(capturedUrl).toContain("f.sid=sid-val");
    expect(capturedBody).toContain("at=tok");
    expect(models).toHaveLength(3);
  });

  it("omits f.sid from the URL when sid is null", async () => {
    let capturedUrl;
    const fetchImpl = vi.fn(async (url) => { capturedUrl = url; return { text: async () => SAMPLE_MODEL_LIST_FRAME }; });
    await fetchGeminiModelList({ at: "tok", bl: "bl-val", sid: null }, fetchImpl);
    expect(capturedUrl).not.toContain("f.sid");
  });

  it("caches per connectionId within the TTL", async () => {
    const fetchImpl = vi.fn(async () => ({ text: async () => SAMPLE_MODEL_LIST_FRAME }));
    await getGeminiModelList("conn-1", { at: "t", bl: "b", sid: "s" }, fetchImpl);
    await getGeminiModelList("conn-1", { at: "t", bl: "b", sid: "s" }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
