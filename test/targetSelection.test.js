import test from "node:test";
import assert from "node:assert/strict";

import { selectDouyinTarget } from "../src/app/douyin/targetSelection.js";

const page = (id, url, title = "抖音") => ({
  id,
  type: "page",
  title,
  url,
  webSocketDebuggerUrl: `ws://page/${id}`,
});

test("target selection keeps a safe session target ahead of other Douyin pages", () => {
  const selected = selectDouyinTarget([
    page("search", "https://www.douyin.com/search/%E7%8C%AB"),
    page("stored", "https://www.douyin.com/jingxuan"),
  ], { preferredTargetId: "stored" });
  assert.equal(selected.id, "stored");
});

test("target selection excludes user profiles and private-message windows", () => {
  const selected = selectDouyinTarget([
    page("user", "https://www.douyin.com/user/sec123"),
    page("private", "https://www.douyin.com/message", "私信"),
    page("video", "https://www.douyin.com/search/foo?modal_id=123"),
  ], { preferredTargetId: "user" });
  assert.equal(selected.id, "video");
});

test("target selection returns null instead of hijacking the only user profile", () => {
  assert.equal(selectDouyinTarget([
    page("user", "https://www.douyin.com/user/sec123"),
  ]), null);
});

test("target selection ignores unrelated Douyin subdomains", () => {
  const selected = selectDouyinTarget([
    page("live", "https://live.douyin.com/"),
    page("main", "https://www.douyin.com/jingxuan"),
  ]);
  assert.equal(selected.id, "main");
});
