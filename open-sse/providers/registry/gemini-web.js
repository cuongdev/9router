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
    format: "gemini-web",
    authType: "cookie",
  },
  models: [
    { id: "gemini-web-flash", name: "Gemini 3.6 Flash (Web)" },
    { id: "gemini-web-thinking", name: "Gemini 3.6 Thinking (Web)" },
    { id: "gemini-web-pro", name: "Gemini 3.1 Pro (Web)" },
  ],
  passthroughModels: true,
};
