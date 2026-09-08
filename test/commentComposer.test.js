import test from "node:test";
import assert from "node:assert/strict";

import {
  scoreCommentComposerCandidate,
  scoreCommentSendCandidate,
} from "../src/app/douyin/commentComposer.js";

const viewport = { width: 2_048, height: 1_104 };

test("accepts plaintext-only editor in the right comment panel", () => {
  const score = scoreCommentComposerCandidate({
    visible: true,
    editable: true,
    contentEditable: true,
    tagName: "div",
    placeholder: "留下你的精彩评论吧",
    ancestorCommentSignal: true,
    rect: { left: 1_485, right: 1_920, top: 1_030, bottom: 1_090, width: 435, height: 60 },
  }, viewport);

  assert.ok(score > 100);
});

test("rejects the left danmu editor even when contenteditable", () => {
  const score = scoreCommentComposerCandidate({
    visible: true,
    editable: true,
    contentEditable: true,
    tagName: "div",
    placeholder: "发一条友好的弹幕吧",
    ancestorDanmuSignal: true,
    rect: { left: 280, right: 990, top: 1_030, bottom: 1_090, width: 710, height: 60 },
  }, viewport);

  assert.equal(score, null);
});

test("rejects a generic bottom input outside the right comment panel", () => {
  const score = scoreCommentComposerCandidate({
    visible: true,
    editable: true,
    tagName: "input",
    rect: { left: 300, right: 900, top: 1_030, bottom: 1_090, width: 600, height: 60 },
  }, viewport);

  assert.equal(score, null);
});

test("accepts a red circular arrow button paired with the comment editor", () => {
  const composer = {
    rect: { left: 1_485, right: 1_920, top: 1_030, bottom: 1_090, width: 435, height: 60 },
  };
  const score = scoreCommentSendCandidate({
    visible: true,
    sameContainer: true,
    red: true,
    sendSignal: false,
    hasSvg: true,
    circle: true,
    tagName: "button",
    role: "button",
    rect: { left: 1_942, right: 1_990, top: 1_036, bottom: 1_084, width: 48, height: 48 },
  }, composer, viewport);

  assert.ok(score > 100);
});

test("accepts Douyin's transparent clickable span with a red SVG path", () => {
  const composer = {
    rect: { left: 1_220, right: 1_559, top: 1_030, bottom: 1_090, width: 339, height: 60 },
  };
  const score = scoreCommentSendCandidate({
    visible: true,
    sameContainer: true,
    red: true,
    redDescendant: true,
    sendSignal: false,
    hasSvg: true,
    circle: true,
    cursorPointer: true,
    tagName: "span",
    role: "",
    rect: { left: 1_651, right: 1_687, top: 1_034, bottom: 1_070, width: 36, height: 36 },
  }, composer, viewport);

  assert.ok(score > 100);
});

test("rejects red buttons not paired with the selected comment editor", () => {
  const composer = {
    rect: { left: 1_485, right: 1_920, top: 1_030, bottom: 1_090, width: 435, height: 60 },
  };
  const score = scoreCommentSendCandidate({
    visible: true,
    sameContainer: false,
    red: true,
    hasSvg: true,
    circle: true,
    tagName: "button",
    rect: { left: 1_900, right: 1_940, top: 500, bottom: 540, width: 40, height: 40 },
  }, composer, viewport);

  assert.equal(score, null);
});

test("rejects a gray text send control until the red button is active", () => {
  const composer = {
    rect: { left: 1_485, right: 1_920, top: 1_030, bottom: 1_090, width: 435, height: 60 },
  };
  const score = scoreCommentSendCandidate({
    visible: true,
    sameContainer: true,
    red: false,
    sendSignal: true,
    tagName: "button",
    rect: { left: 1_930, right: 1_990, top: 1_035, bottom: 1_085, width: 60, height: 50 },
  }, composer, viewport);

  assert.equal(score, null);
});
