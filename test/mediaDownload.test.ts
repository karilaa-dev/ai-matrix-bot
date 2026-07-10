import { describe, expect, it, vi } from "vitest";
import { downloadMatrixMedia } from "../src/matrix/client.js";

function streamedResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers });
}

describe("authenticated Matrix media download", () => {
  it("uses the authenticated endpoint and collects a bounded stream", async () => {
    const fetch = vi.fn(async () => streamedResponse(["hello", " world"], { "content-length": "11" }));
    await expect(downloadMatrixMedia({
      url: "mxc://remote.example/media-id",
      homeserverUrl: "https://matrix.example.org",
      accessToken: "secret-token",
      maxBytes: 20,
      fetch,
    })).resolves.toEqual(Buffer.from("hello world"));
    expect(fetch).toHaveBeenCalledWith(
      "https://matrix.example.org/_matrix/client/v1/media/download/remote.example/media-id",
      { headers: { authorization: "Bearer secret-token" } },
    );
  });

  it("rejects declared and streamed bodies above the limit", async () => {
    await expect(downloadMatrixMedia({
      url: "mxc://remote.example/large",
      homeserverUrl: "https://matrix.example.org",
      accessToken: "token",
      maxBytes: 5,
      fetch: async () => streamedResponse(["tiny"], { "content-length": "6" }),
    })).rejects.toThrow("20 MiB limit");

    await expect(downloadMatrixMedia({
      url: "mxc://remote.example/streamed",
      homeserverUrl: "https://matrix.example.org",
      accessToken: "token",
      maxBytes: 5,
      fetch: async () => streamedResponse(["123", "456"]),
    })).rejects.toThrow("20 MiB limit");
  });
});
