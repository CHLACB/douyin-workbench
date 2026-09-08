import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommentUrl, mergeCollectedComments, mergeDomLocations, normalizeComment, normalizeCommentTextForMatch, pickCommentIpLocation, summarizeCommentUrl } from "../src/app/douyin/commentData.js";

test("classifies only Douyin comment list URLs with aweme id", () => {
  assert.equal(classifyCommentUrl("https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=1&cursor=0"), "comment-list");
  assert.equal(classifyCommentUrl("https://www.douyin.com/aweme/v1/web/comment/list/reply/?aweme_id=1&comment_id=2"), "reply-list");
  assert.equal(classifyCommentUrl("https://www.douyin.com/aweme/v1/web/comment/list/?cursor=0"), null);
  assert.equal(classifyCommentUrl("not a url"), null);
});

test("summarizes sensitive comment URL without raw URL by default", () => {
  const summary = summarizeCommentUrl("https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=1&cursor=0&msToken=secret&a_bogus=sig", false);
  assert.equal(summary.params.aweme_id, "1");
  assert.equal(summary.params.cursor, "0");
  assert.equal(summary.hasToken, true);
  assert.equal(summary.hasSignature, true);
  assert.equal(summary.rawUrl, undefined);
});

test("normalizes network comments", () => {
  const normalized = normalizeComment({ aweme_id: "10", cid: "20", text: "hello", digg_count: 3, reply_comment_total: 4, ip_label: "山东", user: { nickname: "nick", uid: "30", sec_uid: "sec", unique_id: "u", short_id: "s" } }, { type: "comment-list" });
  assert.equal(normalized.source, "comment-list");
  assert.equal(normalized.comment_id, "20");
  assert.equal(normalized.comment_ip_location, "山东");
  assert.equal(normalized.user_link, "https://www.douyin.com/user/sec");
});

test("merges visible DOM locations into network comments", () => {
  assert.equal(pickCommentIpLocation({ user: { ip_label: "江苏" } }), "江苏");
  assert.equal(normalizeCommentTextForMatch(" a  b c "), "abc");
  const merged = mergeDomLocations([{ text: "这是一条评论", user_sec_uid: "sec", comment_ip_location: "" }], [{ raw_text: "这是一条评论 1小时前 江苏", user_sec_uid: "sec", comment_ip_location: "江苏" }]);
  assert.equal(merged[0].comment_ip_location, "江苏");
});

test("DOM fallback comments enter the final collection without duplicating network comments", () => {
  const merged = mergeCollectedComments(
    [{ comment_id: "1", text: "network", user_sec_uid: "a" }],
    [
      { raw_text: "network", user_sec_uid: "a" },
      { raw_text: "DOM only", user_sec_uid: "b", user_nickname: "B" },
    ],
    { awemeId: "123" },
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[1].text, "DOM only");
  assert.equal(merged[1].aweme_id, "123");
});
