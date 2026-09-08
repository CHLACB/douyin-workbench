export function isVideoActuallyOpen(pageState) {
  if (!pageState || typeof pageState !== "object") return false;
  if (pageState.inVideoModal === true) return true;
  const pathname = String(pageState.pathname || safePathname(pageState.url));
  return /^\/(?:video|note)(?:\/|$)/i.test(pathname) || hasModalId(pageState.url);
}

export function deriveSendConfirmation(observation = {}) {
  const blocked = Boolean(observation.blocked || observation.refused);
  const beforeValue = String(observation.inputBefore || "").trim();
  const afterValue = String(observation.inputAfter || "").trim();
  const inputCleared = Boolean(observation.inputWasPresent) && beforeValue.length > 0 && afterValue.length === 0;
  const matchCountBefore = toCount(observation.matchCountBefore);
  const matchCountAfter = toCount(observation.matchCountAfter);
  const newMatchingItem = matchCountAfter > matchCountBefore;
  const confirmed = !blocked && inputCleared && newMatchingItem;
  const evidence = [];
  if (inputCleared) evidence.push("composer-cleared");
  if (newMatchingItem) evidence.push("new-matching-item-visible");
  if (blocked) evidence.push("blocked-or-refused");

  return {
    confirmed,
    sent: confirmed,
    blocked,
    refused: Boolean(observation.refused),
    inputCleared,
    newMatchingItem,
    matchCountBefore,
    matchCountAfter,
    evidence,
    reason: confirmed
      ? "发送后输入框已清空，并出现新的同内容记录"
      : blocked
        ? "页面显示发送受限或被拒收"
        : "点击已执行，但页面没有给出足够的发送成功证据",
  };
}

function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function safePathname(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).pathname;
  } catch {
    return "";
  }
}

function hasModalId(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).searchParams.has("modal_id");
  } catch {
    return false;
  }
}
