import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkflowAssessment } from "../src/app/douyin/workflow.js";

function workflow(partial) {
  return buildWorkflowAssessment({
    page: { url: "https://www.douyin.com/jingxuan", inSearchPage: false, inVideoModal: false, ...partial.page },
    searchBox: partial.searchBox ?? { ok: true },
    commentPanel: partial.commentPanel ?? { ok: false },
    videoCandidates: partial.videoCandidates ?? [],
  });
}

test("home page with search box recommends search", () => {
  const result = workflow({});
  assert.equal(result.current, "home-or-normal-page");
  assert.equal(result.nextAction.command, "search");
});

test("search page with candidates recommends opening video", () => {
  const result = workflow({ page: { inSearchPage: true }, videoCandidates: [{ index: 0 }] });
  assert.equal(result.current, "search-results");
  assert.equal(result.nextAction.command, "open-video");
});

test("video modal with comments recommends watch", () => {
  const result = workflow({ page: { inVideoModal: true }, commentPanel: { ok: true } });
  assert.equal(result.current, "video-modal-with-comments");
  assert.equal(result.nextAction.command, "watch");
});
