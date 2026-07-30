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
