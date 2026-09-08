export function scoreCommentComposerCandidate(candidate, viewport) {
  const rect = candidate?.rect || {};
  const width = Number(viewport?.width || 0);
  const height = Number(viewport?.height || 0);
  const combined = [
    candidate?.text,
    candidate?.placeholder,
    candidate?.aria,
    candidate?.role,
    candidate?.className,
  ].filter(Boolean).join(" ");

  if (!candidate?.visible || !candidate?.editable || width <= 0 || height <= 0) {
    return null;
  }
  if (rect.width < 100 || rect.height < 20 || rect.bottom < height * 0.55 || rect.top >= height - 2) {
    return null;
  }
  if (/弹幕|发一条友好的弹幕|danmu|barrage/i.test(combined) || candidate.ancestorDanmuSignal) {
    return null;
  }

  const inRightZone = rect.left >= width * 0.66 && rect.right >= width * 0.82;
  const inCommentPanel = Boolean(candidate.inCommentPanel || candidate.ancestorCommentSignal);
  if (!inRightZone && !inCommentPanel) {
    return null;
  }

  const hasCommentSignal = /评论|精彩评论|留下|comment/i.test(combined) || candidate.ancestorCommentSignal;
  let score = 0;
  if (inRightZone) score += 48;
  if (inCommentPanel) score += 34;
  if (hasCommentSignal) score += 34;
  if (candidate.contentEditable) score += 14;
  if (/textarea|input/i.test(candidate.tagName || "")) score += 10;
  if (rect.bottom > height - 130) score += 12;
  if (rect.width >= 240) score += 5;
  if (candidate.active) score += 2;
  return score;
}

export function scoreCommentSendCandidate(candidate, composer, viewport) {
  const rect = candidate?.rect || {};
  const composerRect = composer?.rect || {};
  const width = Number(viewport?.width || 0);
  const height = Number(viewport?.height || 0);
  if (!candidate?.visible || candidate?.disabled || !candidate?.sameContainer || width <= 0 || height <= 0) {
    return null;
  }
  if (rect.width < 24 || rect.height < 22 || rect.bottom < height * 0.55) {
    return null;
  }
  if (candidate.danmuSignal) {
    return null;
  }

  const centerY = rect.top + rect.height / 2;
  const composerCenterY = composerRect.top + composerRect.height / 2;
  const nearComposerY = Math.abs(centerY - composerCenterY) <= Math.max(54, composerRect.height);
  const onComposerRight = centerY >= composerRect.top - 24 &&
    centerY <= composerRect.bottom + 24 &&
    rect.left >= composerRect.left + Math.min(80, composerRect.width * 0.2) &&
    rect.right <= Math.max(composerRect.right + 180, width);
  if (!nearComposerY || !onComposerRight) {
    return null;
  }
  if (!candidate.red) {
    return null;
  }

  let score = 0;
  if (candidate.red) score += 55;
  if (candidate.redDescendant) score += 10;
  if (candidate.sendSignal) score += 48;
  if (candidate.tagName === "button") score += 22;
  if (candidate.tagName === "span") score += 4;
  if (candidate.role === "button") score += 14;
  if (candidate.cursorPointer) score += 10;
  if (candidate.hasSvg) score += 8;
  if (candidate.circle) score += 8;
  if (rect.left > composerRect.left + composerRect.width * 0.58) score += 15;
  if (rect.bottom > height - 140) score += 8;
  return score;
}
