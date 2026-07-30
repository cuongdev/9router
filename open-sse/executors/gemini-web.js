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
