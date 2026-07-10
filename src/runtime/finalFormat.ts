import type { CompletedTurnResult, ToolActivity } from "@karilaa-dev/codex-core";

const MAX_REASONING_CHARS = 4_000;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n\n…`;
}

function toolLine(tool: ToolActivity): string {
  const name = tool.name.replace(/`/g, "\\`");
  if (tool.error) return `- \`${name}\` — failed`;
  if (tool.finishedAt !== undefined) return `- \`${name}\` — completed`;
  return `- \`${name}\` — started`;
}

/** Combines the authoritative answer with bounded, non-sensitive activity summaries. */
export function formatCompletedTurn(result: CompletedTurnResult): string {
  const sections = [result.finalMarkdown.trim() || "Done."];
  const reasoning = result.reasoningMarkdown.trim();
  if (reasoning) {
    sections.push(`<details><summary>Reasoning</summary>\n\n${truncate(reasoning, MAX_REASONING_CHARS)}\n\n</details>`);
  }
  if (result.tools.length) {
    const lines = result.tools.slice(0, 10).map(toolLine);
    if (result.tools.length > 10) lines.push(`- …and ${result.tools.length - 10} more`);
    sections.push(`<details><summary>Tools (${result.tools.length})</summary>\n\n${lines.join("\n")}\n\n</details>`);
  }
  return sections.join("\n\n");
}
