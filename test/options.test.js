import test from "node:test";
import assert from "node:assert/strict";
import { parseDelayRange, parseStepDelayRange, readCommentCollectConfig, readDurationMs, readNonNegativeInt, readPositiveInt, readRange, readSearchCycleConfig, readWatchCycleConfig } from "../src/app/douyin/options.js";

test("readDurationMs prefers seconds over milliseconds", () => {
  assert.equal(readDurationMs(500, 2.5, 100), 2500);
  assert.equal(readDurationMs(500, "", 100), 500);
  assert.equal(readDurationMs(null, null, 100), 100);
});

test("integer readers fall back on invalid values", () => {
  assert.equal(readPositiveInt("3", 1), 3);
  assert.equal(readPositiveInt("0", 1), 1);
  assert.equal(readNonNegativeInt("0", 9), 0);
  assert.equal(readNonNegativeInt("-1", 9), 9);
});

test("range validation rejects inverted ranges", () => {
  assert.deepEqual(readRange(1, 2, 10, 20, "范围"), { min: 1, max: 2 });
  assert.throws(() => readRange(3, 2, 10, 20, "范围"), /最大值不能小于最小值/);
});

test("delay and cycle configs normalize seconds", () => {
  assert.deepEqual(parseDelayRange({ minDelayMs: 10, maxDelayMs: 20 }), { min: 10, max: 20 });
  assert.deepEqual(parseStepDelayRange({ minStepDelaySec: 1, maxStepDelaySec: 2 }), { min: 1000, max: 2000 });
  const watch = readWatchCycleConfig({ minWatchSec: 5, maxWatchSec: 6, direction: "up" });
  assert.equal(watch.nextKey, "ArrowUp");
  assert.deepEqual(watch.watchRange, { min: 5000, max: 6000 });
  const search = readSearchCycleConfig({ searches: 2, minBrowseSec: 7, maxBrowseSec: 8 }, 3);
  assert.equal(search.searches, 2);
  assert.deepEqual(search.browseRange, { min: 7000, max: 8000 });
});

test("comment collection config validates scroll driver", () => {
  assert.equal(readCommentCollectConfig({ scrollDriver: "hybrid" }).scrollDriver, "hybrid");
  assert.throws(() => readCommentCollectConfig({ scrollDriver: "bad" }), /scroll-driver/);
});
