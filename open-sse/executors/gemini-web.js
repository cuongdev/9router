import { Agent } from "undici";
import { BaseExecutor } from "./base.js";

export const GEMINI_FALLBACK_BL = "boq_assistant-bard-web-server_20260728.05_p0";
const GEMINI_APP_URL = "https://gemini.google.com/app";
const AUTH_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Google's responses here carry many Set-Cookie/tracking headers — especially when the
// request's own Cookie header is large (a full pasted document.cookie) — and routinely
// exceed undici/Node's default 8KB header size limit (UND_ERR_HEADERS_OVERFLOW). Use a
// dedicated dispatcher with a much higher ceiling for every real request this file makes.
const GEMINI_HTTP_AGENT = new Agent({ headersTimeout: 30000, maxHeaderSize: 131072 });

export function parseGeminiAuthHtml(html, finalUrl) {
  const at = html.match(/"SNlM0e":"([^"]+)"/)?.[1] ?? null;
  const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1] ?? GEMINI_FALLBACK_BL;
  const sid = html.match(/"FdrFJe":"(-?\d+)"/)?.[1] ?? null;
  const redirectedToLogin = /accounts\.google\.com/.test(finalUrl || "");
  return { at, bl, sid, redirectedToLogin };
}

export async function scrapeGeminiAuth(cookie, fetchImpl = fetch) {
  const res = await fetchImpl(GEMINI_APP_URL, { headers: { Cookie: cookie }, dispatcher: GEMINI_HTTP_AGENT });
  const html = await res.text();
  return parseGeminiAuthHtml(html, res.url || GEMINI_APP_URL);
}

const authCache = new Map(); // connectionId -> { value, expiresAt }

export function clearGeminiAuthCache() {
  authCache.clear();
}

export async function getGeminiAuth(connectionId, cookie, fetchImpl = fetch) {
  const cached = authCache.get(connectionId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await scrapeGeminiAuth(cookie, fetchImpl);
  authCache.set(connectionId, { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
  return value;
}

const GEMINI_BATCHEXECUTE_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const GEMINI_MODEL_SHORT_NAMES = {
  "gemini-web-flash": "Flash",
  "gemini-web-thinking": "Thinking",
  "gemini-web-pro": "Pro",
};

function buildBatchExecuteUrl(rpcId, bl, sid, reqId) {
  const params = new URLSearchParams({
    rpcids: rpcId,
    "source-path": "/app",
    bl,
    hl: "en",
    pageId: "none",
    _reqid: String(reqId),
    rt: "c",
  });
  if (sid) params.set("f.sid", sid);
  return `${GEMINI_BATCHEXECUTE_URL}?${params.toString()}`;
}

export function parseGeminiModelList(rawText) {
  for (const line of rawText.split("\n")) {
    if (!line.includes('"wrb.fr"') || !line.includes("otAQ7b")) continue;
    try {
      const outer = JSON.parse(line);
      const innerStr = outer?.[0]?.[2];
      if (!innerStr) continue;
      const inner = JSON.parse(innerStr);
      const rawModels = inner?.[15];
      if (!Array.isArray(rawModels)) continue;
      return rawModels.map((m) => ({
        hashId: m[0],
        shortName: m[1],
        displayName: m[11],
        mode: m[17],
        isDefault: !!m[7],
      }));
    } catch {
      continue;
    }
  }
  return [];
}

// Note: intentionally no explicit 401/403 handling here. If the cookie is bad enough that
// otAQ7b itself is unauthorized, this simply returns [] (see parseGeminiModelList below),
// resolveGeminiModel falls back to its no-models-found default, and the subsequent
// StreamGenerate call in Task 6 will itself 401 — which IS handled there (force-refresh +
// retry-once). Duplicating that handling here would just add an extra error path for the
// same outcome one call later.
export async function fetchGeminiModelList(auth, fetchImpl = fetch) {
  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const url = buildBatchExecuteUrl("otAQ7b", auth.bl, auth.sid, reqId);
  const body = new URLSearchParams({
    "f.req": '[[["otAQ7b","[]",null,"generic"]]]',
    at: auth.at || "",
  }).toString();
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
    dispatcher: GEMINI_HTTP_AGENT,
  });
  const text = await res.text();
  return parseGeminiModelList(text);
}

const modelCache = new Map(); // connectionId -> { value, expiresAt }

export function clearGeminiModelCache() {
  modelCache.clear();
}

export async function getGeminiModelList(connectionId, auth, fetchImpl = fetch) {
  const cached = modelCache.get(connectionId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await fetchGeminiModelList(auth, fetchImpl);
  modelCache.set(connectionId, { value, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
  return value;
}

const DEFAULT_THINK = 4;

export function resolveGeminiModel(modelId, modelList) {
  if (!Array.isArray(modelList) || modelList.length === 0) {
    return { mode: 1, think: DEFAULT_THINK, hashId: null, displayName: modelId };
  }
  const wantedShortName = GEMINI_MODEL_SHORT_NAMES[modelId] || modelId;
  const found = modelList.find(
    (m) => m.shortName === wantedShortName || m.hashId === modelId || m.shortName?.toLowerCase() === String(modelId).toLowerCase()
  );
  const chosen = found || modelList.find((m) => m.isDefault) || modelList[0];
  return { mode: chosen.mode, think: DEFAULT_THINK, hashId: chosen.hashId, displayName: chosen.displayName };
}

// Aspect ratio for image generation is opted into with a model suffix, e.g.
// "gemini-web-flash:16x9". Gemini's image model has no protocol field for it, but it
// reliably honors a natural-language ratio hint in the prompt (verified: 1x1 → 512x512,
// 9x16 → 286x512). So parse the suffix off the model id and turn it into a prompt hint.
const ASPECT_HINTS = {
  "1x1": "a square 1:1 aspect ratio",
  "16x9": "a wide 16:9 landscape aspect ratio",
  "9x16": "a tall 9:16 vertical portrait aspect ratio",
  "4x3": "a 4:3 landscape aspect ratio",
  "3x4": "a 3:4 portrait aspect ratio",
  "3x2": "a 3:2 landscape aspect ratio",
  "2x3": "a 2:3 portrait aspect ratio",
};

export function parseAspectSuffix(model) {
  const m = String(model || "").match(/^(.*):(\d{1,2}x\d{1,2})$/i);
  if (!m) return { baseModel: model, aspectHint: null };
  const key = m[2].toLowerCase();
  return { baseModel: m[1], aspectHint: ASPECT_HINTS[key] || `a ${key.replace("x", ":")} aspect ratio` };
}

export function buildGeminiFreq(prompt, mode, think) {
  const inner = new Array(80).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[think]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = mode;
  return JSON.stringify([null, JSON.stringify(inner)]);
}

export function extractGeminiText(rawText) {
  const bardErr = rawText.match(/BardErrorInfo\s*\[(\d+)\]/);
  if (bardErr) throw new Error(`BardErrorInfo [${bardErr[1]}]`);

  const texts = [];
  for (const line of rawText.split("\n")) {
    if (!line.includes('"wrb.fr"') || line.length < 50) continue;
    try {
      const arr = JSON.parse(line);
      const innerStr = arr?.[0]?.[2];
      if (!innerStr) continue;
      const inner = JSON.parse(innerStr);
      const chunk = inner?.[4];
      if (!Array.isArray(chunk)) continue;
      for (const part of chunk) {
        if (Array.isArray(part) && Array.isArray(part[1])) {
          for (const t of part[1]) if (typeof t === "string" && t.length > 0) texts.push(t);
        }
      }
    } catch {
      continue;
    }
  }
  for (let i = texts.length - 1; i >= 0; i--) if (texts[i].trim()) return texts[i];
  return "";
}

// Generated images come back inline in the same StreamGenerate frame as auth-gated
// lh3.googleusercontent.com/gg-dl/ URLs, nested a few levels under the response
// candidate as tuples of shape [null, 1, "<filename>.png", "<url>", null, "<sig>"].
// Rather than depend on exact indices (they shift), walk the parsed frame and pair
// each gg-dl URL with the filename string immediately preceding it.
const GEMINI_IMAGE_URL_RE = /^https:\/\/lh3\.googleusercontent\.com\/gg-dl\//;

export function extractGeminiImages(rawText) {
  const images = [];
  const seen = new Set();

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string" && GEMINI_IMAGE_URL_RE.test(v)) {
          if (!seen.has(v)) {
            seen.add(v);
            const prev = node[i - 1];
            const filename = typeof prev === "string" && /\.(png|jpe?g|webp)$/i.test(prev) ? prev : null;
            images.push({ filename, url: v });
          }
        } else if (v && typeof v === "object") {
          walk(v);
        }
      }
    } else if (node && typeof node === "object") {
      // Media can be nested inside JSON objects (e.g. {"87": [...]}), not just arrays.
      for (const key of Object.keys(node)) walk(node[key]);
    }
  };

  for (const line of rawText.split("\n")) {
    if (!line.includes('"wrb.fr"')) continue;
    try {
      const arr = JSON.parse(line);
      const innerStr = arr?.[0]?.[2];
      if (!innerStr) continue;
      walk(JSON.parse(innerStr));
    } catch {
      continue;
    }
  }
  return images;
}

// Generated audio/video (Lyria songs, video clips) come back not as gg-dl image URLs but
// as usercontent.google.com/download links carrying a ?filename= (e.g. music.mp3,
// output.mp4). Walk the frame and collect each unique download URL with its filename.
const GEMINI_DOWNLOAD_URL_RE = /^https:\/\/[a-z0-9.-]*usercontent\.google\.com\/download\b/i;

export function extractGeminiDownloads(rawText) {
  const files = [];
  const seen = new Set();

  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
    } else if (node && typeof node === "object") {
      // Audio/video download URLs are nested inside JSON objects (e.g. {"87": [...]}).
      for (const key of Object.keys(node)) walk(node[key]);
    } else if (typeof node === "string" && GEMINI_DOWNLOAD_URL_RE.test(node)) {
      if (!seen.has(node)) {
        seen.add(node);
        let filename = null;
        try { filename = new URL(node).searchParams.get("filename"); } catch { /* ignore */ }
        files.push({ filename, url: node });
      }
    }
  };

  for (const line of rawText.split("\n")) {
    if (!line.includes('"wrb.fr"')) continue;
    try {
      const arr = JSON.parse(line);
      const innerStr = arr?.[0]?.[2];
      if (!innerStr) continue;
      walk(JSON.parse(innerStr));
    } catch {
      continue;
    }
  }
  return files;
}

// When media is generated, Gemini leaves a placeholder token in the answer text, e.g.
// http://googleusercontent.com/image_generation_content/N (images) or
// .../generated_music_content/N (songs). Strip any such *_content placeholder so clients
// don't see a dead link; leave plain text untouched so text-only responses stay byte-identical.
const GEMINI_MEDIA_PLACEHOLDER_RE = /https?:\/\/googleusercontent\.com\/[a-z_]*content\/\S*/g;

export function stripImagePlaceholder(text) {
  if (!text || !/googleusercontent\.com\/[a-z_]*content\//.test(text)) return text;
  return text
    .replace(GEMINI_MEDIA_PLACEHOLDER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const GEMINI_IMAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

const GEMINI_MEDIA_MAX_BYTES = 12 * 1024 * 1024; // cap inlined media (esp. song videos)

// Generated media (images, audio, video) is tied to the account session, so an external
// client can't fetch the URL. Pull the bytes here with the connection's cookie and inline
// them as base64.
//
// The URL 302-redirects across usercontent.google.com hosts before the bytes; undici (and
// fetch) drop the Cookie header on a cross-origin redirect, which lands on a 403 HTML page.
// So follow redirects manually, re-attaching the cookie on every hop. Fail-open: any error,
// the 403 HTML page, or an over-size file drops just that item, never the whole turn.
export async function fetchGeminiMediaBase64(url, cookie, fetchImpl = fetch, { maxBytes = GEMINI_MEDIA_MAX_BYTES } = {}) {
  try {
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetchImpl(current, {
        headers: { Cookie: cookie, "User-Agent": GEMINI_IMAGE_UA, Referer: "https://gemini.google.com/" },
        dispatcher: GEMINI_HTTP_AGENT,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get?.("location");
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const contentType = res.headers?.get?.("content-type") || "application/octet-stream";
      if (/text\/html/i.test(contentType)) return null; // the 403 error page, not media
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) return null;
      return { b64: Buffer.from(buf).toString("base64"), contentType };
    }
    return null; // too many redirects
  } catch {
    return null;
  }
}

// Backward-compatible alias: images go through the same auth-gated media fetch.
export const fetchGeminiImageBase64 = fetchGeminiMediaBase64;

import { PROVIDERS } from "../config/providers.js";
import { SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { flattenChatMessages } from "../utils/flattenChatMessages.js";

const GEMINI_STREAM_GENERATE_URL =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";

function buildStreamGenerateUrl(bl, reqId) {
  const params = new URLSearchParams({ bl, hl: "en", _reqid: String(reqId), rt: "c" });
  return `${GEMINI_STREAM_GENERATE_URL}?${params.toString()}`;
}

function jsonError(status, message, code) {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", ...(code ? { code } : {}) } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildGeminiStreamingResponse(text, model, cid, created) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk({
        id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
      })));
      const words = text.length > 0 ? text.split(/(?<=\s)/) : [];
      for (const word of words) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: word }, finish_reason: null, logprobs: null }],
        })));
      }
      controller.enqueue(encoder.encode(sseChunk({
        id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
        choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      })));
      // No `[DONE]` here: with transport.format:"openai" this stream goes through
      // chatCore's passthrough pipeline, which appends its own `[DONE]` at flush —
      // emitting one here as well produced a duplicate (verified live).
      controller.close();
    },
  });
}

function buildGeminiNonStreamingResponse(text, model, cid, created, usageText = text) {
  const promptTokens = Math.ceil((usageText || "").length / 4);
  return new Response(JSON.stringify({
    id: cid, object: "chat.completion", created, model, system_fingerprint: null,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: promptTokens, total_tokens: promptTokens * 2 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", PROVIDERS["gemini-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log, fetchImpl = fetch }) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { response: jsonError(400, "Missing or empty messages array"), url: GEMINI_STREAM_GENERATE_URL, headers: {}, transformedBody: body };
    }

    const cookie = credentials?.apiKey || "";
    const connectionId = credentials?.connectionId || cookie;
    const authInvalidError = () => jsonError(401, "Gemini cookie hết hạn hoặc không hợp lệ, vui lòng dán lại document.cookie.", "GEMINI_COOKIE_INVALID");

    let auth;
    try {
      auth = await getGeminiAuth(connectionId, cookie, fetchImpl);
    } catch (err) {
      log?.error?.("GEMINI-WEB", `Auth bootstrap failed: ${err.message || String(err)}`);
      return { response: jsonError(502, `Gemini bootstrap failed: ${err.message || String(err)}`), url: GEMINI_STREAM_GENERATE_URL, headers: {}, transformedBody: body };
    }

    if (auth.redirectedToLogin) {
      log?.warn?.("GEMINI-WEB", "Bootstrap GET redirected to accounts.google.com — cookie invalid/expired");
      return { response: authInvalidError(), url: GEMINI_STREAM_GENERATE_URL, headers: {}, transformedBody: body };
    }
    if (!auth.at) {
      // Known Google-side flakiness: SNlM0e sometimes absent from page HTML without a
      // login redirect. Proceed with an empty token — only escalate if the chat call itself 401s.
      log?.warn?.("GEMINI-WEB", "SNlM0e token not found in page HTML; proceeding without it");
    }

    const modelList = await getGeminiModelList(connectionId, auth, fetchImpl);
    // Strip an optional aspect-ratio suffix (e.g. gemini-web-flash:16x9) before resolving,
    // then fold it into the prompt as a hint the image model honors.
    const { baseModel, aspectHint } = parseAspectSuffix(model);
    const resolved = resolveGeminiModel(baseModel, modelList);
    let prompt = flattenChatMessages(messages);
    if (aspectHint) prompt = `${prompt}\n\n(If you generate an image, use ${aspectHint}.)`;

    const sendOnce = async (authToUse) => {
      const reqId = Math.floor(Math.random() * 900000) + 100000;
      const url = buildStreamGenerateUrl(authToUse.bl, reqId);
      const bodyStr = new URLSearchParams({
        "f.req": buildGeminiFreq(prompt, resolved.mode, resolved.think),
        at: authToUse.at || "",
      }).toString();
      const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Same-Domain": "1", Cookie: cookie };
      const fetchOpts = { method: "POST", headers, body: bodyStr, dispatcher: GEMINI_HTTP_AGENT };
      if (signal) fetchOpts.signal = signal;
      const response = await fetchImpl(url, fetchOpts);
      return { response, url, headers, bodyStr };
    };

    log?.info?.("GEMINI-WEB", `Query to ${model} (resolved=${resolved.displayName}, mode=${resolved.mode}), len=${prompt.length}`);

    let attempt;
    try {
      attempt = await sendOnce(auth);
    } catch (err) {
      log?.error?.("GEMINI-WEB", `Fetch failed: ${err.message || String(err)}`);
      return { response: jsonError(502, `Gemini connection failed: ${err.message || String(err)}`), url: GEMINI_STREAM_GENERATE_URL, headers: {}, transformedBody: body };
    }

    if (!attempt.response.ok && (attempt.response.status === 401 || attempt.response.status === 403)) {
      // Chat RPC itself rejected the token — force a fresh bootstrap (bypassing the cache) and retry once.
      log?.warn?.("GEMINI-WEB", `StreamGenerate returned ${attempt.response.status}; re-bootstrapping auth and retrying once`);
      let freshAuth;
      try {
        freshAuth = await scrapeGeminiAuth(cookie, fetchImpl);
      } catch (err) {
        return { response: authInvalidError(), url: attempt.url, headers: {}, transformedBody: attempt.bodyStr };
      }
      authCache.set(connectionId, { value: freshAuth, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
      if (freshAuth.redirectedToLogin) {
        return { response: authInvalidError(), url: attempt.url, headers: {}, transformedBody: attempt.bodyStr };
      }
      try {
        attempt = await sendOnce(freshAuth);
      } catch (err) {
        log?.error?.("GEMINI-WEB", `Retry fetch failed: ${err.message || String(err)}`);
        return { response: jsonError(502, `Gemini connection failed: ${err.message || String(err)}`), url: attempt.url, headers: {}, transformedBody: attempt.bodyStr };
      }
      if (!attempt.response.ok && (attempt.response.status === 401 || attempt.response.status === 403)) {
        return { response: authInvalidError(), url: attempt.url, headers: {}, transformedBody: attempt.bodyStr };
      }
    }

    const { response, url, headers, bodyStr } = attempt;

    if (!response.ok) {
      const status = response.status;
      let errMsg = `Gemini returned HTTP ${status}`;
      if (status === 429) errMsg = "Gemini rate limited. Wait a moment and retry.";
      log?.warn?.("GEMINI-WEB", errMsg);
      return { response: jsonError(status, errMsg, `HTTP_${status}`), url, headers: {}, transformedBody: bodyStr };
    }

    const rawText = await response.text();
    let text;
    try {
      text = extractGeminiText(rawText);
    } catch (err) {
      log?.warn?.("GEMINI-WEB", `Upstream error: ${err.message}`);
      return { response: jsonError(502, err.message, "GEMINI_UPSTREAM_ERROR"), url, headers: {}, transformedBody: bodyStr };
    }
    // Image generation: the answer carries a placeholder token plus one or more
    // auth-gated image URLs. Strip the placeholder, fetch each image server-side with
    // the connection cookie, and inline it as a base64 markdown image so any chat client
    // renders it. Fail-open: a failed image fetch is skipped, the text still returns.
    let content = stripImagePlaceholder(text);
    const images = extractGeminiImages(rawText);
    if (images.length > 0) {
      const dataUrls = [];
      for (const img of images) {
        const fetched = await fetchGeminiImageBase64(img.url, cookie, fetchImpl);
        if (fetched) dataUrls.push(`data:${fetched.contentType};base64,${fetched.b64}`);
      }
      if (dataUrls.length > 0) {
        const markdown = dataUrls.map((u) => `![generated image](${u})`).join("\n\n");
        content = content ? `${content}\n\n${markdown}` : markdown;
        log?.info?.("GEMINI-WEB", `Inlined ${dataUrls.length}/${images.length} generated image(s)`);
      }
    }

    // Audio/video generation (Lyria songs, video clips): delivered as auth-gated
    // usercontent.google.com/download files. Chat clients can't play audio inline, so fetch
    // each server-side and inline it as a base64 data-URL markdown link the client can open.
    const downloads = extractGeminiDownloads(rawText);
    if (downloads.length > 0) {
      const links = [];
      for (const dl of downloads) {
        const fetched = await fetchGeminiMediaBase64(dl.url, cookie, fetchImpl);
        if (fetched) links.push(`[${dl.filename || "file"}](data:${fetched.contentType};base64,${fetched.b64})`);
      }
      if (links.length > 0) {
        const markdown = links.join("\n\n");
        content = content ? `${content}\n\n${markdown}` : markdown;
        log?.info?.("GEMINI-WEB", `Inlined ${links.length}/${downloads.length} media file(s)`);
      }
    }

    if (!content) {
      return { response: jsonError(502, "Gemini returned an empty response"), url, headers: {}, transformedBody: bodyStr };
    }

    const cid = `chatcmpl-gemini-web-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    const finalResponse = stream
      ? new Response(buildGeminiStreamingResponse(content, model, cid, created), { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } })
      : buildGeminiNonStreamingResponse(content, model, cid, created, text);

    return { response: finalResponse, url, headers: {}, transformedBody: bodyStr };
  }
}

export default GeminiWebExecutor;
