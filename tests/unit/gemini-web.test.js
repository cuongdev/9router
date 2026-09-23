import { describe, it, expect, vi, beforeEach } from "vitest";
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
  buildGeminiFreq,
  extractGeminiText,
  extractGeminiImages,
  extractGeminiDownloads,
  stripImagePlaceholder,
  fetchGeminiImageBase64,
  fetchGeminiMediaBase64,
  parseAspectSuffix,
  GeminiWebExecutor,
} from "../../open-sse/executors/gemini-web.js";

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

  it("uses a custom dispatcher with a larger header size limit (Google's response headers routinely exceed undici's 8KB default)", async () => {
    let capturedOpts;
    const fetchImpl = vi.fn(async (url, opts) => {
      capturedOpts = opts;
      return { url: "https://gemini.google.com/app", text: async () => SAMPLE_HTML_LOGGED_IN };
    });
    await scrapeGeminiAuth("cookie-fixture-abc", fetchImpl);
    expect(capturedOpts.dispatcher).toBeDefined();
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

describe("buildGeminiFreq", () => {
  it("embeds the prompt, mode and think flag in the freeze-encoded payload", () => {
    const freq = buildGeminiFreq("hello world", 3, 4);
    const [, innerStr] = JSON.parse(freq);
    const inner = JSON.parse(innerStr);
    expect(inner[0][0]).toBe("hello world");
    expect(inner[79]).toBe(3);
    expect(inner[17]).toEqual([[4]]);
  });

  it("is valid JSON at both the outer and inner level", () => {
    const freq = buildGeminiFreq("q", 1, 4);
    expect(() => JSON.parse(freq)).not.toThrow();
    const [outerFirst, innerStr] = JSON.parse(freq);
    expect(outerFirst).toBeNull();
    expect(() => JSON.parse(innerStr)).not.toThrow();
  });
});

describe("extractGeminiText", () => {
  it("returns the last non-empty cumulative text frame", () => {
    const frame1 = ["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, ["Hel"]]]])];
    const frame2 = ["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, ["Hello world"]]]])];
    const raw = JSON.stringify([frame1]) + "\n" + JSON.stringify([frame2]) + "\n";
    expect(extractGeminiText(raw)).toBe("Hello world");
  });

  it("throws when a BardErrorInfo marker is present", () => {
    expect(() => extractGeminiText("some text BardErrorInfo [32] more text")).toThrow(/BardErrorInfo \[32\]/);
  });

  it("returns an empty string when no frame contains text", () => {
    expect(extractGeminiText('[["di",270]]\n')).toBe("");
  });
});

// Faithful shape of a real StreamGenerate image-generation frame: the answer text is a
// placeholder token, and each generated image is an auth-gated gg-dl URL nested a few
// levels under the candidate as [null, 1, "<filename>.png", "<url>", null, "<sig>"].
function mockStreamGenerateImageBody(
  url = "https://lh3.googleusercontent.com/gg-dl/AAQ_test_generated_image_url",
  answerText = "\n\nhttp://googleusercontent.com/image_generation_content/0_608\n\n",
) {
  const inner = [
    null,
    ["c_conv", "r_resp"],
    null,
    null,
    [[
      "rc_1",
      [answerText],
      null, null, null, null, null, null, [1], null, null, null,
      [null, null, null, null, null, null, null,
        [[[[null, null, null, [null, 1, "watermarked_img_123.png", url, null, "$sig"]]]]],
      ],
    ]],
  ];
  const frame = ["wrb.fr", null, JSON.stringify(inner)];
  return JSON.stringify([frame]) + "\n";
}

describe("extractGeminiImages", () => {
  it("pulls the gg-dl image URL and its filename from a generation frame", () => {
    const images = extractGeminiImages(mockStreamGenerateImageBody());
    expect(images).toEqual([
      { filename: "watermarked_img_123.png", url: "https://lh3.googleusercontent.com/gg-dl/AAQ_test_generated_image_url" },
    ]);
  });

  it("returns an empty array for a text-only frame", () => {
    const frame = ["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, ["just text"]]]])];
    expect(extractGeminiImages(JSON.stringify([frame]) + "\n")).toEqual([]);
  });

  it("de-dupes a URL that appears more than once in the frame", () => {
    const url = "https://lh3.googleusercontent.com/gg-dl/AAQ_dupe";
    const inner = [null, null, null, null, [[[null, 1, "a.png", url], [null, 1, "a.png", url]]]];
    const frame = ["wrb.fr", null, JSON.stringify(inner)];
    expect(extractGeminiImages(JSON.stringify([frame]) + "\n")).toHaveLength(1);
  });
});

describe("extractGeminiDownloads", () => {
  it("pulls usercontent download URLs with their filename (audio/video)", () => {
    const audio = "https://contribution.usercontent.google.com/download?c=abc&filename=music.mp3&opi=1";
    const video = "https://contribution.usercontent.google.com/download?c=def&filename=output.mp4";
    const inner = [null, null, null, null, [["rc", ["a song"], null, [null, [audio, video]]]]];
    const frame = ["wrb.fr", null, JSON.stringify(inner)];
    const files = extractGeminiDownloads(JSON.stringify([frame]) + "\n");
    expect(files).toEqual([
      { filename: "music.mp3", url: audio },
      { filename: "output.mp4", url: video },
    ]);
  });

  it("returns an empty array when there are no download URLs", () => {
    const frame = ["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, ["plain text"]]]])];
    expect(extractGeminiDownloads(JSON.stringify([frame]) + "\n")).toEqual([]);
  });

  it("does not treat gg-dl image URLs as downloads", () => {
    const frame = ["wrb.fr", null, JSON.stringify([null, null, null, null, [[[null, 1, "a.png", "https://lh3.googleusercontent.com/gg-dl/x"]]]])];
    expect(extractGeminiDownloads(JSON.stringify([frame]) + "\n")).toEqual([]);
  });

  it("skips non-media downloads like thought_signature_*.pb", () => {
    const audio = "https://contribution.usercontent.google.com/download?c=a&filename=music.mp3";
    const sig = "https://contribution.usercontent.google.com/download?c=b&filename=thought_signature_123.pb";
    const inner = [null, null, null, null, [["rc", ["x"], null, { "87": [[audio, sig]] }]]];
    const frame = ["wrb.fr", null, JSON.stringify(inner)];
    const files = extractGeminiDownloads(JSON.stringify([frame]) + "\n");
    expect(files).toEqual([{ filename: "music.mp3", url: audio }]);
  });

  it("finds download URLs nested inside JSON objects (not just arrays)", () => {
    const audio = "https://contribution.usercontent.google.com/download?c=a&filename=song.mp3";
    const inner = [null, null, null, null, [["rc", ["x"], null, { "87": [[null, [audio]]] }]]];
    const frame = ["wrb.fr", null, JSON.stringify(inner)];
    expect(extractGeminiDownloads(JSON.stringify([frame]) + "\n")).toEqual([{ filename: "song.mp3", url: audio }]);
  });
});

describe("stripImagePlaceholder", () => {
  it("removes the image_generation_content placeholder and trims", () => {
    expect(stripImagePlaceholder("\n\nhttp://googleusercontent.com/image_generation_content/0_608\n\n")).toBe("");
  });

  it("keeps a caption around the placeholder", () => {
    const out = stripImagePlaceholder("Here you go:\n\nhttp://googleusercontent.com/image_generation_content/0_1\n\nEnjoy!");
    expect(out).toBe("Here you go:\n\nEnjoy!");
  });

  it("leaves plain text untouched (byte-identical)", () => {
    expect(stripImagePlaceholder("Hello from Gemini")).toBe("Hello from Gemini");
    expect(stripImagePlaceholder("  leading and trailing  ")).toBe("  leading and trailing  ");
  });
});

describe("fetchGeminiImageBase64", () => {
  it("fetches with the connection cookie and returns base64 + content type", async () => {
    let capturedOpts;
    const fetchImpl = vi.fn(async (url, opts) => {
      capturedOpts = opts;
      return { ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => new TextEncoder().encode("PNGDATA").buffer };
    });
    const out = await fetchGeminiImageBase64("https://lh3.googleusercontent.com/gg-dl/x", "cookie-abc", fetchImpl);
    expect(capturedOpts.headers.Cookie).toBe("cookie-abc");
    expect(out.contentType).toBe("image/png");
    expect(Buffer.from(out.b64, "base64").toString()).toBe("PNGDATA");
  });

  it("follows 302 redirects, re-attaching the cookie on every hop (undici drops it cross-origin)", async () => {
    const cookiesSeen = [];
    const hops = [
      { status: 302, headers: { get: (k) => (k === "location" ? "https://work.fife.usercontent.google.com/rd-gg-dl/y" : null) } },
      { status: 302, headers: { get: (k) => (k === "location" ? "https://lh3.googleusercontent.com/rd-gg-dl/z" : null) } },
      { ok: true, status: 200, headers: { get: (k) => (k === "content-type" ? "image/png" : null) }, arrayBuffer: async () => new TextEncoder().encode("PNGBYTES").buffer },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async (_url, opts) => {
      cookiesSeen.push(opts?.headers?.Cookie);
      return hops[i++];
    });
    const out = await fetchGeminiImageBase64("https://lh3.googleusercontent.com/gg-dl/x", "cookie-abc", fetchImpl);
    expect(out).toEqual({ b64: Buffer.from("PNGBYTES").toString("base64"), contentType: "image/png" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(cookiesSeen).toEqual(["cookie-abc", "cookie-abc", "cookie-abc"]);
  });

  it("returns null when the final response is not an image (e.g. a 403 HTML page slipped through)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => new ArrayBuffer(8) }));
    expect(await fetchGeminiImageBase64("https://lh3.googleusercontent.com/gg-dl/x", "c", fetchImpl)).toBeNull();
  });

  it("fails open (returns null) on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } }));
    expect(await fetchGeminiImageBase64("https://lh3.googleusercontent.com/gg-dl/x", "c", fetchImpl)).toBeNull();
  });

  it("fails open (returns null) when the fetch throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network"); });
    expect(await fetchGeminiImageBase64("https://lh3.googleusercontent.com/gg-dl/x", "c", fetchImpl)).toBeNull();
  });
});

describe("parseAspectSuffix", () => {
  it("returns the model unchanged with no hint when there is no suffix", () => {
    expect(parseAspectSuffix("gemini-web-flash")).toEqual({ baseModel: "gemini-web-flash", aspectHint: null });
  });

  it("splits a known ratio suffix into the base model and a natural-language hint", () => {
    expect(parseAspectSuffix("gemini-web-flash:16x9")).toEqual({
      baseModel: "gemini-web-flash",
      aspectHint: "a wide 16:9 landscape aspect ratio",
    });
    expect(parseAspectSuffix("gemini-web-pro:1x1").aspectHint).toBe("a square 1:1 aspect ratio");
    expect(parseAspectSuffix("gemini-web-flash:9x16").aspectHint).toContain("9:16");
  });

  it("accepts an arbitrary NxN ratio not in the preset map", () => {
    expect(parseAspectSuffix("gemini-web-flash:21x9")).toEqual({
      baseModel: "gemini-web-flash",
      aspectHint: "a 21:9 aspect ratio",
    });
  });

  it("ignores a trailing colon that is not a valid ratio", () => {
    expect(parseAspectSuffix("gemini-web-flash:pro")).toEqual({ baseModel: "gemini-web-flash:pro", aspectHint: null });
  });
});

function mockGeminiHtml() {
  return SAMPLE_HTML_LOGGED_IN;
}

function mockStreamGenerateBody(text) {
  const frame = ["wrb.fr", null, JSON.stringify([null, null, null, null, [[null, [text]]]])];
  return JSON.stringify([frame]) + "\n";
}

describe("GeminiWebExecutor.execute", () => {
  beforeEach(() => {
    clearGeminiAuthCache();
    clearGeminiModelCache();
  });

  function makeFetch({ streamGenerateText = "Hello from Gemini" } = {}) {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes("gemini.google.com/app")) {
        return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      }
      if (url.includes("otAQ7b")) {
        return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      }
      if (url.includes("StreamGenerate")) {
        return { ok: true, status: 200, text: async () => mockStreamGenerateBody(streamGenerateText) };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    return { fetchImpl, calls };
  }

  it("returns a non-streaming chat.completion response with the extracted text", async () => {
    const { fetchImpl } = makeFetch();
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-1" },
      fetchImpl,
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello from Gemini");
  });

  it("returns a simulated SSE stream with the extracted text chunked, for stream: true", async () => {
    const { fetchImpl } = makeFetch({ streamGenerateText: "Hi there friend" });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-1" },
      fetchImpl,
    });
    const text = await response.text();
    expect(text).toContain("data: ");
    // No [DONE] here by design: transport.format:"openai" routes this through chatCore's
    // passthrough pipeline, which appends its own [DONE] at flush — emitting one from the
    // executor too produced a duplicate in the full pipeline (verified live).
    expect(text).not.toContain("[DONE]");
    expect(text.includes("Hi") && text.includes("there") && text.includes("friend")).toBe(true);
  });

  it("only bootstraps auth/models once across two chat calls on the same connection", async () => {
    const { fetchImpl, calls } = makeFetch();
    const exec = new GeminiWebExecutor();
    const req = {
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-1" },
      fetchImpl,
    };
    await exec.execute(req);
    await exec.execute(req);
    const bootstrapCalls = calls.filter((c) => c.url.includes("/app") || c.url.includes("otAQ7b"));
    expect(bootstrapCalls).toHaveLength(2); // one /app GET + one otAQ7b POST, only on the first call
  });

  it("returns 400 when messages is missing or empty", async () => {
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: {},
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-1" },
    });
    expect(response.status).toBe(400);
  });

  it("returns 401 with a re-paste-cookie message when the bootstrap scrape is not logged in", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/app")) return { url: "https://accounts.google.com/signin", text: async () => "<html>login</html>" };
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "expired-cookie", connectionId: "conn-2" },
      fetchImpl,
    });
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.message).toMatch(/cookie|dán lại/i);
  });

  it("maps a BardErrorInfo body to a 502 upstream error", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/app")) return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      if (url.includes("otAQ7b")) return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      if (url.includes("StreamGenerate")) return { ok: true, status: 200, text: async () => "BardErrorInfo [32]" };
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-3" },
      fetchImpl,
    });
    expect(response.status).toBe(502);
  });

  it("maps HTTP 429 from StreamGenerate to a 429 response", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/app")) return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      if (url.includes("otAQ7b")) return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      if (url.includes("StreamGenerate")) return { ok: false, status: 429, text: async () => "" };
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-4" },
      fetchImpl,
    });
    expect(response.status).toBe(429);
  });

  it("retries once with a fresh bootstrap when StreamGenerate 401s, and succeeds on the second attempt", async () => {
    let streamGenerateCalls = 0;
    let appScrapeCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/app")) {
        appScrapeCalls++;
        return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      }
      if (url.includes("otAQ7b")) return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      if (url.includes("StreamGenerate")) {
        streamGenerateCalls++;
        if (streamGenerateCalls === 1) return { ok: false, status: 401, text: async () => "" };
        return { ok: true, status: 200, text: async () => mockStreamGenerateBody("recovered answer") };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-5" },
      fetchImpl,
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("recovered answer");
    expect(streamGenerateCalls).toBe(2);
    expect(appScrapeCalls).toBe(2); // initial bootstrap + forced re-bootstrap after the 401
  });

  it("returns 401 cookie-invalid if StreamGenerate still 401s after the retry", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/app")) return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      if (url.includes("otAQ7b")) return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      if (url.includes("StreamGenerate")) return { ok: false, status: 401, text: async () => "" };
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-6" },
      fetchImpl,
    });
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.message).toMatch(/cookie|dán lại/i);
  });

  it("inlines a generated image as a base64 markdown image and strips the placeholder", async () => {
    let imageFetchCookie;
    const fetchImpl = vi.fn(async (url, opts) => {
      if (url.includes("/app")) return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      if (url.includes("otAQ7b")) return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      if (url.includes("StreamGenerate")) return { ok: true, status: 200, text: async () => mockStreamGenerateImageBody() };
      if (url.includes("gg-dl")) {
        imageFetchCookie = opts?.headers?.Cookie;
        return { ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => new TextEncoder().encode("IMG").buffer };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "draw a red bicycle" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-img" },
      fetchImpl,
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    const content = json.choices[0].message.content;
    // Placeholder token is gone; image is inlined as a base64 data URL markdown image.
    expect(content).not.toContain("image_generation_content");
    expect(content).toContain(`![generated image](data:image/png;base64,${Buffer.from("IMG").toString("base64")})`);
    // Image was fetched server-side with the connection cookie (URL is auth-gated).
    expect(imageFetchCookie).toBe("cookie-fixture-abc");
    // Token usage is estimated from the text part, not the base64 blob.
    expect(json.usage.prompt_tokens).toBeLessThan(50);
  });

  it("still returns the text turn when the image fetch fails (fail-open)", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/app")) return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      if (url.includes("otAQ7b")) return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      if (url.includes("StreamGenerate")) {
        // A caption plus the placeholder, so stripped text is non-empty.
        const body = mockStreamGenerateImageBody(
          "https://lh3.googleusercontent.com/gg-dl/AAQ_test_generated_image_url",
          "Here is your image:\n\nhttp://googleusercontent.com/image_generation_content/0_1\n\n",
        );
        return { ok: true, status: 200, text: async () => body };
      }
      if (url.includes("gg-dl")) return { ok: false, status: 403 };
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "draw a red bicycle" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-img2" },
      fetchImpl,
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.choices[0].message.content).toContain("Here is your image:");
    expect(json.choices[0].message.content).not.toContain("data:image");
  });

  it("strips a :NxN aspect suffix for model resolution and folds the ratio into the prompt", async () => {
    const { fetchImpl, calls } = makeFetch();
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash:9x16",
      body: { messages: [{ role: "user", content: "a red apple" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-aspect" },
      fetchImpl,
    });
    // Base model still resolves (a 200, not a "model not found" style failure).
    expect(response.status).toBe(200);
    // The StreamGenerate request body carries the ratio hint folded into the prompt.
    const streamCall = calls.find((c) => c.url.includes("StreamGenerate"));
    const fReq = new URLSearchParams(streamCall.opts.body).get("f.req");
    expect(fReq).toContain("9:16");
    expect(fReq).toContain("a red apple");
  });

  it("inlines a generated audio file as a base64 data-URL markdown link", async () => {
    const audioUrl = "https://contribution.usercontent.google.com/download?c=abc&filename=music.mp3";
    const inner = [null, ["c", "r"], null, null, [["rc", ["Here is your song"], null, [null, [audioUrl]]]]];
    const streamBody = JSON.stringify([["wrb.fr", null, JSON.stringify(inner)]]) + "\n";
    let mediaCookie;
    const fetchImpl = vi.fn(async (url, opts) => {
      if (url.includes("/app")) return { url: "https://gemini.google.com/app", text: async () => mockGeminiHtml() };
      if (url.includes("otAQ7b")) return { text: async () => SAMPLE_MODEL_LIST_FRAME };
      if (url.includes("StreamGenerate")) return { ok: true, status: 200, text: async () => streamBody };
      if (url.includes("usercontent.google.com/download")) {
        mediaCookie = opts?.headers?.Cookie;
        return { ok: true, status: 200, headers: { get: () => "audio/mpeg" }, arrayBuffer: async () => new TextEncoder().encode("MP3").buffer };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    const exec = new GeminiWebExecutor();
    const { response } = await exec.execute({
      model: "gemini-web-flash",
      body: { messages: [{ role: "user", content: "make a song" }] },
      stream: false,
      credentials: { apiKey: "cookie-fixture-abc", connectionId: "conn-audio" },
      fetchImpl,
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    const content = json.choices[0].message.content;
    expect(content).toContain("Here is your song");
    expect(content).toContain(`[music.mp3](data:audio/mpeg;base64,${Buffer.from("MP3").toString("base64")})`);
    expect(mediaCookie).toBe("cookie-fixture-abc");
  });
});
