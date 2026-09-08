export function buildCommentFinalSnapshot(result, options = {}) {
  const includeRawUrls = options.includeRawUrls === true;
  const snapshot = {
    ok: Boolean(result?.ok),
    source: result?.source || "",
    stopReason: result?.stopReason || "",
    elapsedMs: Number(result?.elapsedMs || 0),
    awemeId: result?.awemeId || "",
    target: result?.target || null,
    initialUrl: result?.initialUrl || "",
    finalUrl: result?.finalUrl || "",
    comments: Array.isArray(result?.comments) ? result.comments : [],
    network: result?.network ? {
      pageCount: result.network.pageCount || 0,
      commentCount: result.network.commentCount || 0,
      hasMore: result.network.hasMore ?? null,
      nextCursor: result.network.nextCursor ?? null,
      totalReported: result.network.totalReported ?? null,
      pages: result.network.pages || [],
      errors: result.network.errors || [],
      matchedRequests: result.network.matchedRequests || [],
    } : null,
    domFallback: result?.domFallback || null,
    domLocations: result?.domLocations || null,
  };
  return includeRawUrls ? snapshot : stripSensitiveRawUrls(snapshot);
}

export function buildCommentTerminalEvents(result, options = {}) {
  const ts = typeof options.now === "function" ? options.now() : new Date().toISOString();
  return [
    {
      ts,
      event: "final-snapshot",
      snapshot: buildCommentFinalSnapshot(result, options),
    },
    {
      ts,
      event: "done",
      summary: buildCommentSummary(result),
    },
  ];
}

export function buildCommentSummary(result) {
  return {
    ok: Boolean(result?.ok),
    stopReason: result?.stopReason || "",
    elapsedMs: result?.elapsedMs || 0,
    commentCount: Array.isArray(result?.comments) ? result.comments.length : 0,
    pageCount: result?.network?.pageCount || 0,
    hasMore: result?.network?.hasMore ?? null,
    totalReported: result?.network?.totalReported ?? null,
    awemeId: result?.awemeId || "",
  };
}

export function stripSensitiveRawUrls(value) {
  if (Array.isArray(value)) return value.map(stripSensitiveRawUrls);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (/^raw_?url$/i.test(key)) continue;
    output[key] = stripSensitiveRawUrls(nestedValue);
  }
  return output;
}
