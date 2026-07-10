import { describe, expect, it } from "vitest";
import { markdownToHtml, renderMessage, splitMarkdown } from "../src/matrix/render.js";

describe("Matrix-safe Markdown rendering", () => {
  it("preserves useful rich content while sanitizing executable HTML", () => {
    const html = markdownToHtml([
      "# Heading",
      "",
      "<script>alert('bad')</script>",
      "",
      "[safe](https://example.org) [unsafe](javascript:alert(1))",
      "",
      "<details><summary>Reasoning</summary>details</details>",
      "<kbd>keyboard</kbd><math><mi>x</mi></math>",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n"));

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<details><summary>Reasoning</summary>details</details>");
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<kbd");
    expect(html).not.toContain("<math");
    expect(html).not.toContain("<mi");
  });

  it("renders a threaded notice with plaintext and safe HTML fallbacks", () => {
    const rendered = renderMessage("**Working…**", {
      notice: true,
      threadRoot: "$thread-root",
      replyToEventId: "$question",
    });

    expect(rendered).toMatchObject({
      msgtype: "m.notice",
      body: "**Working…**",
      format: "org.matrix.custom.html",
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: "$thread-root",
        "m.in_reply_to": { event_id: "$question" },
      },
    });
    expect(rendered.formatted_body).toContain("<strong>Working…</strong>");
  });

  it("renders edits with authoritative new content and replacement fallback", () => {
    const rendered = renderMessage("Final answer", { replaceEventId: "$placeholder" });

    expect(rendered.body).toBe("* Final answer");
    expect(rendered["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$placeholder" });
    expect(rendered["m.new_content"]).toMatchObject({
      msgtype: "m.text",
      body: "Final answer",
      format: "org.matrix.custom.html",
    });
  });

  it("renders Matrix spoiler and maths extensions inside the safe allowlist", () => {
    const html = markdownToHtml("Hidden: ||secret||. Inline $x^2$ and block $$y = 2$$.");
    expect(html).toContain("data-mx-spoiler");
    expect(html).toContain('data-mx-maths="x^2"');
    expect(html).toContain('data-mx-maths="y = 2"');
  });
});

describe("block-aware Matrix event splitting", () => {
  it("keeps a short answer as one event", () => {
    expect(splitMarkdown("short answer", 4096)).toEqual(["short answer"]);
  });

  it("prefers Markdown block boundaries and bounds the rendered Matrix payload", () => {
    const first = `First paragraph. ${"a".repeat(1_100)}`;
    const second = `Second paragraph. ${"b".repeat(1_100)}`;
    const markdown = `${first}\n\n${second}\n\n🙂🙂🙂🙂🙂🙂🙂🙂`;
    const chunks = splitMarkdown(markdown, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBe(first);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(renderMessage(chunk))) + 1024).toBeLessThanOrEqual(4096);
    }
    expect(chunks.join("\n\n")).toContain("Second paragraph.");
    expect(chunks.join("")).toContain("🙂🙂🙂🙂🙂🙂🙂🙂");
  });
});
