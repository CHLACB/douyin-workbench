import test from "node:test";
import assert from "node:assert/strict";

import { buildCommentFinalSnapshot, buildCommentTerminalEvents } from "../src/app/douyin/commentStream.js";

test("final comment snapshot contains comments but omits sensitive raw request URLs by default", () => {
  const snapshot = buildCommentFinalSnapshot({
    ok: true,
    awemeId: "123",
    comments: [{ text: "hello", user_link: "https://www.douyin.com/user/sec" }],
    network: {
      pageCount: 1,
      matchedRequests: [{ urlInfo: { rawUrl: "https://www.douyin.com/comment?msToken=secret", pathname: "/comment" } }],
      pages: [{ urlInfo: { raw_url: "secret", pathname: "/comment" } }],
    },
  });

  assert.equal(snapshot.comments[0].text, "hello");
  assert.equal(snapshot.comments[0].user_link, "https://www.douyin.com/user/sec");
  assert.equal(JSON.stringify(snapshot).includes("msToken=secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("rawUrl"), false);
  assert.equal(JSON.stringify(snapshot).includes("raw_url"), false);
});

test("final comment snapshot preserves raw URLs only when explicitly requested", () => {
  const snapshot = buildCommentFinalSnapshot({
    comments: [],
    network: { matchedRequests: [{ urlInfo: { rawUrl: "signed" } }] },
  }, { includeRawUrls: true });
  assert.equal(snapshot.network.matchedRequests[0].urlInfo.rawUrl, "signed");
});

test("stream terminal protocol sends final-snapshot before done", () => {
  const events = buildCommentTerminalEvents({ ok: true, comments: [{ text: "one" }] }, {
    now: () => "2026-08-12T00:00:00.000Z",
  });
  assert.deepEqual(events.map((event) => event.event), ["final-snapshot", "done"]);
  assert.equal(events[0].snapshot.comments.length, 1);
  assert.equal(events[1].summary.commentCount, 1);
});
