import { describe, expect, it } from "vitest";
import { formatCompletedTurn } from "../src/runtime/finalFormat.js";

describe("final Matrix answer formatting", () => {
  it("keeps the authoritative answer and adds bounded reasoning/tool summaries", () => {
    const markdown = formatCompletedTurn({
      status: "completed",
      turnId: "turn-1",
      conversationId: "conversation-1",
      elapsedMs: 10,
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      finalMarkdown: "Authoritative answer",
      reasoningMarkdown: "r".repeat(5_000),
      tools: [{
        callId: "call-1",
        name: "search_thread",
        input: { secret: "must not be rendered" },
        output: { large: "must not be rendered" },
        startedAt: 1,
        finishedAt: 2,
      }],
      attachments: [],
    });

    expect(markdown).toMatch(/^Authoritative answer/);
    expect(markdown).toContain("<summary>Reasoning</summary>");
    expect(markdown).toContain("…");
    expect(markdown).toContain("<summary>Tools (1)</summary>");
    expect(markdown).toContain("`search_thread` — completed");
    expect(markdown).not.toContain("must not be rendered");
  });
});
