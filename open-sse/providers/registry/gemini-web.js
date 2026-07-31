export default {
  id: "gemini-web",
  priority: 230,
  alias: "gemini-web",
  aliases: ["gw2"],
  uiAlias: "gw2",
  display: {
    name: "Gemini Web (Google Account)",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GM",
    website: "https://gemini.google.com",
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Dán toàn bộ document.cookie từ gemini.google.com (F12 → Console → document.cookie)",
  transport: {
    baseUrl: "https://gemini.google.com/_/BardChatUi/data",
    // "openai": the executor already returns fully OpenAI-shaped JSON/SSE itself (no
    // translator registered for a "gemini-web" format), so declaring the real output
    // shape here lets chatCore's streaming pipeline treat this as passthrough instead
    // of trying to translate — a custom format string here silently drops the trailing
    // `[DONE]` SSE event for stream:true requests (verified: the executor's own raw
    // stream output does include it; chatCore's translate-mode path only re-synthesizes
    // it for the Responses API passthrough case, not for a plain custom source format).
    format: "openai",
    authType: "cookie",
  },
  models: [
    { id: "gemini-web-flash", name: "Gemini 3.6 Flash (Web)" },
    { id: "gemini-web-thinking", name: "Gemini 3.6 Thinking (Web)" },
    { id: "gemini-web-pro", name: "Gemini 3.1 Pro (Web)" },
  ],
  passthroughModels: true,
};
