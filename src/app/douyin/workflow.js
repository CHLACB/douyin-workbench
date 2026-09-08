export function buildWorkflowAssessment(state) {
  const url = state.page?.url || "";
  const inSearchPage = Boolean(state.page?.inSearchPage);
  const inVideoModal = Boolean(state.page?.inVideoModal);
  const commentOpen = Boolean(state.commentPanel?.ok);
  const searchReady = Boolean(state.searchBox?.ok);
  const hasVideoCandidates = state.videoCandidates.length > 0;

  const steps = [
    { id: "douyin-page", name: "连接抖音页面", done: Boolean(url.includes("douyin.com")) },
    { id: "search", name: "执行关键词搜索", done: inSearchPage },
    { id: "open-video", name: "选中搜索结果视频", done: inVideoModal },
    { id: "open-comments", name: "打开评论区", done: commentOpen },
    { id: "watch-cycle", name: "刷评论区并切换视频", done: false },
    { id: "search-cycle", name: "刷一会后换未用搜索词", done: false },
  ];

  let current = "unknown";
  let nextAction = { id: "status", name: "刷新状态", command: "status", reason: "无法判断当前位置，先刷新状态。" };

  if (!url.includes("douyin.com")) {
    current = "not-douyin";
    nextAction = { id: "open-browser", name: "打开抖音", command: "open", reason: "当前没有可用抖音页面。" };
  } else if (!inSearchPage && !inVideoModal) {
    current = "home-or-normal-page";
    nextAction = searchReady
      ? { id: "search", name: "搜索关键词", command: "search", reason: "已找到搜索框，下一步应执行关键词搜索。" }
      : { id: "find-search", name: "识别搜索框", command: "find-search", reason: "当前页面未识别到可用搜索框。" };
  } else if (inSearchPage && !inVideoModal) {
    current = "search-results";
    nextAction = hasVideoCandidates
      ? { id: "open-video", name: "打开第一个视频", command: "open-video", reason: "当前在搜索结果页，已经识别到视频卡片。" }
      : { id: "search", name: "重新搜索", command: "search", reason: "当前是搜索结果页，但没有识别到可点击视频。" };
  } else if (inVideoModal && !commentOpen) {
    current = "video-modal-without-comments";
    nextAction = { id: "open-comments", name: "打开评论区", command: "comments", reason: "当前已进入视频浮层，下一步应打开评论区。" };
  } else if (inVideoModal && commentOpen) {
    current = "video-modal-with-comments";
    nextAction = { id: "watch-cycle", name: "刷评论并切换视频", command: "watch", reason: "当前视频和评论区都已就绪，可以开始刷评论和切视频。" };
  }

  return { current, steps, nextAction, flags: { inSearchPage, inVideoModal, commentOpen, searchReady, hasVideoCandidates, videoCandidateCount: state.videoCandidates.length } };
}
