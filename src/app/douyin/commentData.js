export function classifyCommentUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.hostname !== "www.douyin.com") return null;
  if (url.pathname === "/aweme/v1/web/comment/list/" || url.pathname === "/aweme/v1/web/comment/list") {
    return url.searchParams.has("aweme_id") ? "comment-list" : null;
  }
  if (url.pathname === "/aweme/v1/web/comment/list/reply/" || url.pathname === "/aweme/v1/web/comment/list/reply") {
    return url.searchParams.has("aweme_id") ? "reply-list" : null;
  }
  return null;
}

export function summarizeCommentUrl(rawUrl, includeRawUrl) {
  const url = new URL(rawUrl);
  const interestingParams = ["aweme_id", "cursor", "count", "item_type", "comment_id", "reply_id", "has_more"];
  const params = {};
  for (const key of interestingParams) {
    if (url.searchParams.has(key)) params[key] = url.searchParams.get(key);
  }

  return {
    origin: url.origin,
    pathname: url.pathname,
    params,
    hasSignature: url.searchParams.has("a_bogus") || url.searchParams.has("x-secsdk-web-signature"),
    hasToken: url.searchParams.has("msToken"),
    rawUrl: includeRawUrl ? rawUrl : undefined,
  };
}

export function normalizeComment(comment, meta = {}) {
  const user = comment.user || {};
  const secUid = user.sec_uid || user.secUid || "";
  const uid = user.uid || "";
  const uniqueId = user.unique_id || user.uniqueId || "";
  const shortId = user.short_id || user.shortId || "";
  const awemeId = String(comment.aweme_id || meta.urlInfo?.params?.aweme_id || "");
  const commentId = String(comment.cid || "");

  return {
    source: meta.type || "unknown",
    aweme_id: awemeId,
    comment_id: commentId,
    cid: commentId,
    text: comment.text || "",
    likes: Number(comment.digg_count || 0),
    reply_count: Number(comment.reply_comment_total || 0),
    create_time_raw: comment.create_time || "",
    create_time: comment.create_time ? new Date(Number(comment.create_time) * 1000).toLocaleString() : "",
    comment_ip_location: pickCommentIpLocation(comment),
    user_nickname: user.nickname || "",
    user_uid: String(uid || ""),
    user_sec_uid: secUid,
    user_unique_id: uniqueId,
    user_short_id: String(shortId || ""),
    user_link: secUid ? "https://www.douyin.com/user/" + encodeURIComponent(secUid) : "",
  };
}

export function pickCommentIpLocation(comment = {}) {
  const user = comment.user || {};
  return String(
    comment.ip_label || comment.ipLabel || comment.ip_location || comment.ipLocation ||
    comment.location || comment.region || comment.province || comment.address ||
    comment.comment_ip_label || comment.commentIpLabel || comment.comment_ip_location || comment.commentIpLocation ||
    user.ip_label || user.ipLabel || user.ip_location || user.ipLocation || "",
  ).trim();
}

export function normalizeCommentTextForMatch(text) {
  return String(text || "").replace(/\s+/g, "").slice(0, 40);
}

export function mergeDomLocations(networkComments, domComments) {
  if (!Array.isArray(networkComments) || networkComments.length === 0) return networkComments || [];
  if (!Array.isArray(domComments) || domComments.length === 0) return networkComments;

  const candidates = domComments
    .filter((comment) => comment?.comment_ip_location)
    .map((comment) => ({ ...comment, normalizedText: normalizeCommentTextForMatch(comment.comment_text || comment.normalized_text || comment.raw_text) }));

  return networkComments.map((comment) => {
    if (comment.comment_ip_location) return comment;

    const networkText = normalizeCommentTextForMatch(comment.text);
    const exact = candidates.find((candidate) =>
      candidate.user_sec_uid && candidate.user_sec_uid === comment.user_sec_uid && networkText && candidate.normalizedText.includes(networkText)
    );
    const loose = exact || candidates.find((candidate) =>
      networkText && (candidate.normalizedText.includes(networkText) || networkText.includes(candidate.normalizedText))
    );

    return { ...comment, comment_ip_location: loose?.comment_ip_location || "" };
  });
}

export function mergeCollectedComments(networkComments, domComments, options = {}) {
  const network = Array.isArray(networkComments) ? networkComments : [];
  if (!Array.isArray(domComments) || domComments.length === 0) return network;

  const seen = new Set();
  for (const comment of network) {
    for (const identity of commentIdentities(comment)) seen.add(identity);
  }
  const merged = [...network];
  for (const rawComment of domComments) {
    const comment = normalizeDomComment(rawComment, options.awemeId);
    const identities = commentIdentities(comment);
    if (identities.length === 0 || identities.some((identity) => seen.has(identity))) continue;
    for (const identity of identities) seen.add(identity);
    merged.push(comment);
  }
  return merged;
}

function normalizeDomComment(comment, awemeId) {
  const rawText = String(comment?.raw_text || comment?.text || comment?.comment_text || "").trim();
  return {
    source: comment?.source || "dom-loaded-comments",
    aweme_id: String(comment?.aweme_id || awemeId || ""),
    comment_id: String(comment?.comment_id || ""),
    cid: String(comment?.cid || comment?.comment_id || ""),
    text: String(comment?.text || comment?.comment_text || rawText),
    likes: Number(comment?.likes || 0),
    reply_count: Number(comment?.reply_count || 0),
    create_time_raw: comment?.create_time_raw || "",
    create_time: comment?.create_time || "",
    comment_ip_location: String(comment?.comment_ip_location || ""),
    user_nickname: String(comment?.user_nickname || ""),
    user_uid: String(comment?.user_uid || ""),
    user_sec_uid: String(comment?.user_sec_uid || ""),
    user_unique_id: String(comment?.user_unique_id || ""),
    user_short_id: String(comment?.user_short_id || ""),
    user_link: String(comment?.user_link || ""),
    raw_text: rawText,
  };
}

function commentIdentities(comment) {
  const identities = [];
  if (comment?.comment_id) identities.push(`id:${comment.comment_id}`);
  const text = normalizeCommentTextForMatch(comment?.text || comment?.raw_text);
  const user = String(comment?.user_sec_uid || comment?.user_nickname || "");
  if (text) identities.push(`dom:${user}:${text}`);
  return identities;
}
