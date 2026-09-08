import test from "node:test";
import assert from "node:assert/strict";

import { deriveSendConfirmation, isVideoActuallyOpen } from "../src/app/douyin/reliability.js";

test("video opening requires modal or video/note page evidence", () => {
  assert.equal(isVideoActuallyOpen({ url: "https://www.douyin.com/search/cat?keyword=cat" }), false);
  assert.equal(isVideoActuallyOpen({ pathname: "/search/cat", inVideoModal: true }), true);
  assert.equal(isVideoActuallyOpen({ pathname: "/video/123" }), true);
  assert.equal(isVideoActuallyOpen({ url: "https://www.douyin.com/search/cat?modal_id=123" }), true);
});

test("a click alone is not a confirmed send", () => {
  const result = deriveSendConfirmation({
    inputWasPresent: true,
    inputBefore: "hello",
    inputAfter: "hello",
    matchCountBefore: 0,
    matchCountAfter: 0,
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.sent, false);
});

test("send confirmation requires a cleared composer and a new matching record", () => {
  const result = deriveSendConfirmation({
    inputWasPresent: true,
    inputBefore: "hello",
    inputAfter: "",
    matchCountBefore: 1,
    matchCountAfter: 2,
  });
  assert.equal(result.confirmed, true);
  assert.deepEqual(result.evidence, ["composer-cleared", "new-matching-item-visible"]);
});
