import { describe, expect, it } from "vitest";
import {
  deterministicTransactionId,
  normalizeMessage,
  replacementRelation,
  stripReplyFallback,
  threadRelation,
} from "../src/matrix/relations.js";
import type { MatrixEvent } from "../src/matrix/types.js";

function event(content: Record<string, unknown>, overrides: Partial<MatrixEvent> = {}): MatrixEvent {
  return {
    event_id: "$event",
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 123,
    content,
    ...overrides,
  };
}

describe("Matrix relation normalization", () => {
  it("strips only a valid rich-reply plaintext fallback", () => {
    expect(stripReplyFallback("> <@bob:example.org> old\n> second line\n\nnew answer")).toBe("new answer");
    expect(stripReplyFallback("> incomplete without separator")).toBe("> incomplete without separator");
    expect(stripReplyFallback("> quote\nnot quoted\n\nbody")).toBe("> quote\nnot quoted\n\nbody");
    expect(stripReplyFallback("ordinary body")).toBe("ordinary body");
  });

  it("preserves reply metadata while removing fallback text from inference", () => {
    const normalized = normalizeMessage("!room:example.org", event({
      msgtype: "m.text",
      body: "> <@bob:example.org> old\n\nnew answer",
      formatted_body: "<mx-reply>old</mx-reply><p>new answer</p>",
      "m.relates_to": { "m.in_reply_to": { event_id: "$old" } },
    }));

    expect(normalized).toMatchObject({
      eventId: "$event",
      roomId: "!room:example.org",
      sender: "@alice:example.org",
      timestamp: 123,
      threadRoot: "main",
      replyToEventId: "$old",
      body: "new answer",
      formattedBody: "<mx-reply>old</mx-reply><p>new answer</p>",
    });
  });

  it("normalizes native threads and encrypted attachments", () => {
    const normalized = normalizeMessage("!room:example.org", event({
      msgtype: "m.file",
      body: "notes.txt",
      file: {
        url: "mxc://example.org/media",
        key: { kty: "oct", k: "secret" },
        iv: "iv",
        hashes: { sha256: "hash" },
        v: "v2",
      },
      info: { mimetype: "text/plain", size: 12 },
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: "$thread-root",
        "m.in_reply_to": { event_id: "$previous" },
      },
    }));

    expect(normalized).toMatchObject({
      threadRoot: "$thread-root",
      replyToEventId: "$previous",
      msgtype: "m.file",
      media: {
        name: "notes.txt",
        encryptedFile: { url: "mxc://example.org/media", v: "v2" },
        info: { mimetype: "text/plain", size: 12 },
      },
    });
  });

  it("uses replacement content for queued edits and retains the edit target", () => {
    const normalized = normalizeMessage("!room:example.org", event({
      msgtype: "m.text",
      body: "* corrected",
      "m.new_content": { msgtype: "m.text", body: "corrected" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
    }));

    expect(normalized).toMatchObject({ body: "corrected", editTargetEventId: "$original" });
  });

  it.each([
    event({ msgtype: "m.notice", body: "peer status" }),
    event({ msgtype: "m.audio", body: "unsupported" }),
    event({}, { type: "m.reaction" }),
  ])("ignores notices, unsupported messages, and non-message events", (input) => {
    expect(normalizeMessage("!room:example.org", input)).toBeUndefined();
  });
});
describe("outbound relations and transaction IDs", () => {
  it("builds main replies and thread fallback relations", () => {
    expect(threadRelation("main")).toBeUndefined();
    expect(threadRelation("main", "$reply")).toEqual({ "m.in_reply_to": { event_id: "$reply" } });
    expect(threadRelation("$root")).toEqual({
      rel_type: "m.thread",
      event_id: "$root",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$root" },
    });
    expect(replacementRelation("$draft")).toEqual({ rel_type: "m.replace", event_id: "$draft" });
  });

  it("derives stable, bounded, namespaced transaction IDs", () => {
    const first = deterministicTransactionId("!room", "$source", "answer", "0");
    expect(first).toBe(deterministicTransactionId("!room", "$source", "answer", "0"));
    expect(first).not.toBe(deterministicTransactionId("!room", "$source", "attachment", "0"));
    expect(first).toMatch(/^codex_[a-f0-9]{48}$/);
  });
});
