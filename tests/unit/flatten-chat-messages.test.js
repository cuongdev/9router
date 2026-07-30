import { describe, it, expect } from "vitest";
import { flattenChatMessages } from "../../open-sse/utils/flattenChatMessages.js";

describe("flattenChatMessages", () => {
  it("returns the single message unprefixed when there is only one user message", () => {
    const out = flattenChatMessages([{ role: "user", content: "hello" }]);
    expect(out).toBe("hello");
  });

  it("prefixes prior turns with role, leaves the last user message unprefixed", () => {
    const out = flattenChatMessages([
      { role: "system", content: "Be terse" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
    expect(out).toBe("system: Be terse\n\nuser: Q1\n\nassistant: A1\n\nQ2");
  });

  it("treats developer role as system", () => {
    const out = flattenChatMessages([
      { role: "developer", content: "Be concise" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toBe("system: Be concise\n\nhi");
  });

  it("joins multi-part text content blocks with a space", () => {
    const out = flattenChatMessages([
      { role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] },
    ]);
    expect(out).toBe("part1 part2");
  });

  it("skips messages with empty/whitespace-only content", () => {
    const out = flattenChatMessages([
      { role: "user", content: "   " },
      { role: "user", content: "real" },
    ]);
    expect(out).toBe("real");
  });

  it("returns empty string for an empty or all-empty message array", () => {
    expect(flattenChatMessages([])).toBe("");
    expect(flattenChatMessages([{ role: "user", content: "" }])).toBe("");
  });
});
