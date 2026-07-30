import { BaseExecutor } from "./base.js";

export const GEMINI_FALLBACK_BL = "boq_assistant-bard-web-server_20260728.05_p0";
const GEMINI_APP_URL = "https://gemini.google.com/app";
const AUTH_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function parseGeminiAuthHtml(html, finalUrl) {
  const at = html.match(/"SNlM0e":"([^"]+)"/)?.[1] ?? null;
  const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1] ?? GEMINI_FALLBACK_BL;
  const sid = html.match(/"FdrFJe":"(-?\d+)"/)?.[1] ?? null;
  const redirectedToLogin = /accounts\.google\.com/.test(finalUrl || "");
  return { at, bl, sid, redirectedToLogin };
}

export async function scrapeGeminiAuth(cookie, fetchImpl = fetch) {
  const res = await fetchImpl(GEMINI_APP_URL, { headers: { Cookie: cookie } });
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

import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
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
      controller.enqueue(encoder.encode(SSE_DONE));
      controller.close();
    },
  });
}

function buildGeminiNonStreamingResponse(text, model, cid, created) {
  const promptTokens = Math.ceil(text.length / 4);
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
    const resolved = resolveGeminiModel(model, modelList);
    const prompt = flattenChatMessages(messages);

    const sendOnce = async (authToUse) => {
      const reqId = Math.floor(Math.random() * 900000) + 100000;
      const url = buildStreamGenerateUrl(authToUse.bl, reqId);
      const bodyStr = new URLSearchParams({
        "f.req": buildGeminiFreq(prompt, resolved.mode, resolved.think),
        at: authToUse.at || "",
      }).toString();
      const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Same-Domain": "1", Cookie: cookie };
      const fetchOpts = { method: "POST", headers, body: bodyStr };
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
    if (!text) {
      return { response: jsonError(502, "Gemini returned an empty response"), url, headers: {}, transformedBody: bodyStr };
    }

    const cid = `chatcmpl-gemini-web-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    const finalResponse = stream
      ? new Response(buildGeminiStreamingResponse(text, model, cid, created), { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } })
      : buildGeminiNonStreamingResponse(text, model, cid, created);

    return { response: finalResponse, url, headers: {}, transformedBody: bodyStr };
  }
}

export default GeminiWebExecutor;
