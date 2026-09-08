export function parseDelayRange(options) {
  const min = readNonNegativeInt(options.minDelayMs, 400);
  const max = readNonNegativeInt(options.maxDelayMs, 1_200);
  if (max < min) {
    throw new Error("--max-delay-ms 不能小于 --min-delay-ms");
  }
  return { min, max };
}

export function parseStepDelayRange(options) {
  return readRange(
    readDurationMs(options.minStepDelayMs, options.minStepDelaySec, null),
    readDurationMs(options.maxStepDelayMs, options.maxStepDelaySec, null),
    3_000,
    7_000,
    "--min-step-delay-sec / --max-step-delay-sec",
  );
}

export function readWatchCycleConfig(options) {
  const direction = String(options.direction || "down").toLowerCase();
  if (!["down", "up"].includes(direction)) {
    throw new Error("--direction 只支持 down 或 up");
  }

  return {
    cycles: readPositiveInt(options.cycles, 1),
    openComments: options.openComments !== false,
    scrollComments: options.scrollComments !== false,
    stepDelayRange: parseStepDelayRange(options),
    watchRange: readRange(
      readDurationMs(options.minWatchMs, options.minWatchSec, null),
      readDurationMs(options.maxWatchMs, options.maxWatchSec, null),
      120_000,
      180_000,
      "--min-watch-ms / --max-watch-ms 或 --min-watch-sec / --max-watch-sec",
    ),
    commentIntervalRange: readRange(
      readDurationMs(options.commentScrollMinIntervalMs, options.commentScrollMinIntervalSec, null),
      readDurationMs(options.commentScrollMaxIntervalMs, options.commentScrollMaxIntervalSec, null),
      4_500,
      9_000,
      "--comment-scroll-min-interval-ms / --comment-scroll-max-interval-ms 或秒参数",
    ),
    commentDeltaRange: readRange(
      options.commentScrollMinDelta,
      options.commentScrollMaxDelta,
      180,
      420,
      "--comment-scroll-min-delta / --comment-scroll-max-delta",
    ),
    commentOpenWaitMs: readDurationMs(options.commentOpenWaitMs, options.commentOpenWaitSec, 1_800),
    afterNextWaitMs: readDurationMs(options.afterNextWaitMs, options.afterNextWaitSec, 1_800),
    direction,
    nextKey: direction === "up" ? "ArrowUp" : "ArrowDown",
  };
}

export function readSearchCycleConfig(options, termCount) {
  return {
    ...readWatchCycleConfig(options),
    searches: readPositiveInt(options.searches, termCount),
    browseRange: readRange(
      readDurationMs(options.minBrowseMs, options.minBrowseSec, null),
      readDurationMs(options.maxBrowseMs, options.maxBrowseSec, null),
      120_000,
      180_000,
      "--min-browse-ms / --max-browse-ms 或 --min-browse-sec / --max-browse-sec",
    ),
    searchDelayRange: parseDelayRange({
      minDelayMs: options.minDelayMs,
      maxDelayMs: options.maxDelayMs,
    }),
    stepDelayRange: parseStepDelayRange(options),
    searchReadyTimeoutMs: readDurationMs(options.searchReadyTimeoutMs, options.searchReadyTimeoutSec, 20_000),
    videoReadyTimeoutMs: readDurationMs(options.videoReadyTimeoutMs, options.videoReadyTimeoutSec, 30_000),
    searchFirst: Boolean(options.searchFirst),
    openVideoAfterSearch: options.openVideoAfterSearch !== false,
    openVideoIndex: readNonNegativeInt(options.openVideoIndex, 0),
    afterSearchWaitMs: readDurationMs(options.afterSearchWaitMs, options.afterSearchWaitSec, 2_000),
    afterOpenVideoWaitMs: readDurationMs(options.afterOpenVideoWaitMs, options.afterOpenVideoWaitSec, 1_800),
  };
}

export function readCommentCollectConfig(options) {
  const scrollDriver = String(options.scrollDriver || "wheel").toLowerCase();
  if (!["wheel", "hybrid", "dom"].includes(scrollDriver)) {
    throw new Error("--scroll-driver 只支持 wheel、hybrid 或 dom");
  }

  return {
    maxPages: readPositiveInt(options.maxPages, 5),
    maxComments: readPositiveInt(options.maxComments, 120),
    includeReplies: Boolean(options.includeReplies),
    includeRawUrls: Boolean(options.includeRawUrls),
    followVideos: Boolean(options.followVideos),
    listenOnly: Boolean(options.listenOnly) || Boolean(options.followVideos),
    openComments: options.openComments !== false,
    commentOpenWaitMs: readDurationMs(options.commentOpenWaitMs, options.commentOpenWaitSec, 1_800),
    initialCommentWaitMs: readDurationMs(options.initialCommentWaitMs, options.initialCommentWaitSec, 8_000),
    alreadyOpenInitialWaitMs: readDurationMs(options.alreadyOpenInitialWaitMs, options.alreadyOpenInitialWaitSec, 1_500),
    listenTimeoutMs: readDurationMs(options.listenTimeoutMs, options.listenTimeoutSec, 60_000),
    afterScrollWaitMs: readDurationMs(options.afterScrollWaitMs, options.afterScrollWaitSec, 1_200),
    maxNoNewScrolls: readPositiveInt(options.maxNoNewScrolls, 5),
    scrollDriver,
    domFallbackAfterNoNewScrolls: readPositiveInt(options.domFallbackAfterNoNewScrolls, 3),
    scrollIntervalRange: readRange(
      readDurationMs(options.minScrollIntervalMs, options.minScrollIntervalSec, null),
      readDurationMs(options.maxScrollIntervalMs, options.maxScrollIntervalSec, null),
      1_000,
      2_000,
      "--min-scroll-interval-sec / --max-scroll-interval-sec",
    ),
    scrollDeltaRange: readRange(
      options.minScrollDelta,
      options.maxScrollDelta,
      260,
      520,
      "--min-scroll-delta / --max-scroll-delta",
    ),
  };
}

export function readDurationMs(msValue, secValue, fallback) {
  if (secValue != null && secValue !== "") {
    const parsed = Number.parseFloat(String(secValue));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed * 1_000);
    }
  }

  if (msValue != null && msValue !== "") {
    return readNonNegativeInt(msValue, fallback ?? 0);
  }

  return fallback;
}

export function readRange(minValue, maxValue, fallbackMin, fallbackMax, label) {
  const min = readNonNegativeInt(minValue, fallbackMin);
  const max = readNonNegativeInt(maxValue, fallbackMax);
  if (max < min) {
    throw new Error(String(label) + " 的最大值不能小于最小值");
  }
  return { min, max };
}

export function readPositiveInt(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function readNonNegativeInt(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
