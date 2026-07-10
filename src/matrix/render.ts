import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { replacementRelation, threadRelation } from "./relations.js";

export interface RenderedMessage extends Record<string, unknown> {
  msgtype: "m.text" | "m.notice";
  body: string;
  format: "org.matrix.custom.html";
  formatted_body: string;
  "m.relates_to"?: Record<string, unknown>;
  "m.new_content"?: Record<string, unknown>;
}

const allowedTags = [
  "a", "b", "blockquote", "br", "caption", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th",
  "thead", "tr", "u", "ul",
];

export function markdownToHtml(markdown: string): string {
  const rendered = marked.parse(matrixExtensions(markdown), { gfm: true, breaks: true, async: false });
  const html = typeof rendered === "string" ? rendered : markdown;
  return sanitizeHtml(html, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      code: ["class"],
      span: ["data-mx-spoiler", "data-mx-maths", "class"],
      div: ["data-mx-maths", "class"],
      ol: ["start"],
    },
    allowedSchemes: ["http", "https", "mailto", "matrix", "mxc"],
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: { ...attribs, rel: "noopener noreferrer" },
      }),
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function matrixExtensions(markdown: string): string {
  return markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (_match, expression: string) => {
      const value = expression.trim();
      return `<div data-mx-maths="${escapeHtml(value)}"><code>${escapeHtml(value)}</code></div>`;
    })
    .replace(/(^|[^$])\$([^$\n]+)\$(?!\$)/g, (_match, prefix: string, expression: string) => {
      const value = expression.trim();
      return `${prefix}<span data-mx-maths="${escapeHtml(value)}"><code>${escapeHtml(value)}</code></span>`;
    })
    .replace(/\|\|([^|\n]+)\|\|/g, (_match, hidden: string) => `<span data-mx-spoiler>${escapeHtml(hidden)}</span>`);
}

export function renderMessage(
  markdown: string,
  options: {
    notice?: boolean;
    threadRoot?: string;
    replyToEventId?: string;
    replaceEventId?: string;
  } = {},
): RenderedMessage {
  const base = {
    msgtype: options.notice ? "m.notice" as const : "m.text" as const,
    body: markdown,
    format: "org.matrix.custom.html" as const,
    formatted_body: markdownToHtml(markdown),
  };
  const thread = threadRelation(options.threadRoot ?? "main", options.replyToEventId);
  if (!options.replaceEventId) return { ...base, ...(thread ? { "m.relates_to": thread } : {}) };
  return {
    ...base,
    body: `* ${markdown}`,
    "m.new_content": base,
    "m.relates_to": replacementRelation(options.replaceEventId),
  };
}

export function splitMarkdown(markdown: string, maxBytes: number): string[] {
  const fits = (value: string) => Buffer.byteLength(JSON.stringify(renderMessage(value))) + 1024 <= maxBytes;
  if (fits(markdown)) return [markdown];
  const blocks = markdown.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (fits(block)) {
      current = block;
      continue;
    }
    const lines = block.split("\n");
    current = "";
    for (const line of lines) {
      const lineCandidate = current ? `${current}\n${line}` : line;
      if (fits(lineCandidate)) current = lineCandidate;
      else {
        if (current) chunks.push(current);
        let rest = line;
        while (!fits(rest)) {
          let low = 1;
          let high = rest.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(rest.slice(0, middle))) low = middle;
            else high = middle - 1;
          }
          const end = low;
          if (!fits(rest.slice(0, end))) throw new Error("MATRIX_MAX_EVENT_BYTES is too small for a Matrix message");
          chunks.push(rest.slice(0, end));
          rest = rest.slice(end);
        }
        current = rest;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
