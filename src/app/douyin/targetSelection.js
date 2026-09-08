export function selectDouyinTarget(targets, options = {}) {
  const preferredTargetId = String(options.preferredTargetId || "");
  return (Array.isArray(targets) ? targets : [])
    .filter((target) => target?.type === "page" && target.webSocketDebuggerUrl)
    .map((target, order) => ({
      target,
      order,
      score: scoreDouyinTarget(target, preferredTargetId),
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || a.order - b.order)[0]?.target || null;
}

export function scoreDouyinTarget(target, preferredTargetId = "") {
  let url;
  try {
    url = new URL(String(target?.url || ""));
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  if (!/^(?:www\.)?douyin\.com$/i.test(url.hostname)) {
    return Number.NEGATIVE_INFINITY;
  }

  const title = String(target?.title || "");
  const path = url.pathname.toLowerCase();
  const isUserPage = /^\/user(?:\/|$)/.test(path);
  const isMessagingPage = /\/(?:im|message|messages|chat|conversation)(?:\/|$)/.test(path) ||
    /私信|消息中心|聊天/.test(title) && !isPreferredAutomationSurface(url);
  if (isUserPage || isMessagingPage) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 100;
  if (isPreferredAutomationSurface(url)) score += 500;
  if (String(target.id || "") === String(preferredTargetId || "")) score += 1_000;
  if (target.attached === true) score += 5;
  return score;
}

export function isPreferredAutomationSurface(rawUrl) {
  let url;
  try {
    url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl || ""));
  } catch {
    return false;
  }
  const path = url.pathname.toLowerCase();
  return path === "/" || /^\/jingxuan(?:\/|$)/.test(path) || /^\/search(?:\/|$)/.test(path) ||
    /^\/video(?:\/|$)/.test(path) || /^\/note(?:\/|$)/.test(path) || url.searchParams.has("modal_id");
}

export function publicTarget(target) {
  if (!target) return null;
  return {
    id: target.id || "",
    type: target.type || "",
    title: target.title || "",
    url: target.url || "",
  };
}
