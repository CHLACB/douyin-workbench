import fs from "node:fs";
import { DEFAULTS } from "../config/defaults.js";
import { sleep } from "../core/time.js";
import { DevtoolsClient } from "../infra/cdp/DevtoolsClient.js";
import { DevtoolsSession } from "../infra/cdp/DevtoolsSession.js";
import { clickAt, pressKey, wheelAt } from "../infra/cdp/InputActions.js";
import { parseDelayRange, parseStepDelayRange, readCommentCollectConfig, readDurationMs, readNonNegativeInt, readPositiveInt, readSearchCycleConfig, readWatchCycleConfig } from "./douyin/options.js";
import { buildWorkflowAssessment } from "./douyin/workflow.js";
import { classifyCommentUrl, mergeCollectedComments, mergeDomLocations, normalizeComment, summarizeCommentUrl } from "./douyin/commentData.js";
import { scoreCommentComposerCandidate, scoreCommentSendCandidate } from "./douyin/commentComposer.js";
import { deriveSendConfirmation, isVideoActuallyOpen } from "./douyin/reliability.js";
import { publicTarget, selectDouyinTarget } from "./douyin/targetSelection.js";

export class DouyinController {
  async inputSearch(options = {}) {
    const terms = parseTerms(options.terms);
    const delayRange = parseDelayRange(options);
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      const search = await searchVisibleBox(session, {
        term: selectRandomTerm(terms),
        candidates: terms,
        delayRange,
        stepDelayRange: parseStepDelayRange(options),
        searchReadyTimeoutMs: readDurationMs(options.searchReadyTimeoutMs, options.searchReadyTimeoutSec, 20_000),
        submit: options.submit !== false,
      });

      return {
        ...search,
        target: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
      };
    } finally {
      session.close();
    }
  }

  async openVideo(options = {}) {
    const index = readNonNegativeInt(options.index, 0);
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");

      const candidates = await readVideoCandidates(session);
      if (candidates.length === 0) {
        throw new Error("当前页面没有识别到可点击的视频卡片，请确认已经在抖音搜索结果页。");
      }
      if (index >= candidates.length) {
        throw new Error(`视频 index 超出范围：${index}，当前只识别到 ${candidates.length} 个候选视频。`);
      }

      const prepared = await prepareVideoCandidateForClick(session, index);
      if (!prepared.ok) {
        throw new Error(prepared.reason || "视频候选卡片无法滚动到可点击位置。");
      }

      const selected = prepared.selected;
      const beforeState = await readPageSummary(session);
      const beforeUrl = beforeState.url || await readLocationHref(session);
      await clickAt(session, selected.click.x, selected.click.y);
      const waitMs = readNonNegativeInt(options.afterClickWaitMs, 1_800);
      let afterState = await waitForVideoOpenState(session, waitMs);
      let afterUrl = afterState.url || await readLocationHref(session);
      let fallback = null;

      if (!isVideoActuallyOpen(afterState)) {
        fallback = await clickVideoCandidateByDom(session, index);
        afterState = await waitForVideoOpenState(session, waitMs);
        afterUrl = afterState.url || await readLocationHref(session);
      }

      const opened = isVideoActuallyOpen(afterState);

      return {
        ok: opened,
        index,
        candidateCount: prepared.candidateCount || candidates.length,
        selected,
        prepared,
        fallback,
        beforeUrl,
        afterUrl,
        beforeState,
        afterState,
        opened,
        reason: opened ? "" : "点击已执行，但没有检测到视频详情页或视频浮层",
      };
    } finally {
      session.close();
    }
  }

  async openComments(options = {}) {
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const waitMs = readNonNegativeInt(options.commentOpenWaitMs, 1_800);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      await blurActiveElement(session);

      const initialUrl = await readLocationHref(session);
      const commentPanel = await ensureCommentPanelOpen(session, waitMs);

      return {
        ok: commentPanel.ok,
        initialUrl,
        finalUrl: await readLocationHref(session),
        commentPanel,
      };
    } finally {
      session.close();
    }
  }

  async findSearchBox(options = {}) {
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      const searchBox = await readSearchInputState(session);

      return {
        ok: Boolean(searchBox?.ok),
        target: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
        searchBox,
      };
    } finally {
      session.close();
    }
  }

  async watchCycle(options = {}) {
    const config = readWatchCycleConfig(options);
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      await blurActiveElement(session);

      const initialUrl = await readLocationHref(session);
      const beforeCommentsDelayMs = config.openComments
        ? await sleepRandomStep(config, "before-open-comments")
        : 0;
      let commentPanel = config.openComments
        ? await ensureCommentPanelOpen(session, config.commentOpenWaitMs)
        : { ok: false, skipped: true };
      if (config.openComments && !commentPanel.ok) {
        const firstAttempt = commentPanel;
        await sleep(Math.min(300, config.commentOpenWaitMs));
        const retry = await ensureCommentPanelOpen(session, config.commentOpenWaitMs);
        commentPanel = {
          ...retry,
          retried: true,
          firstAttempt,
        };
      }
      const cycles = [];

      for (let cycleIndex = 0; cycleIndex < config.cycles; cycleIndex += 1) {
        const watchMs = randomDelay(config.watchRange);
        const startedAt = Date.now();
        const deadline = startedAt + watchMs;
        const scrolls = [];

        while (Date.now() < deadline) {
          const waitMs = Math.min(randomDelay(config.commentIntervalRange), deadline - Date.now());
          if (waitMs > 0) {
            await sleep(waitMs);
          }
          if (Date.now() >= deadline) {
            break;
          }

          if (config.scrollComments) {
            const targetRect = await readCommentScrollTarget(session);
            const point = readScrollPoint(targetRect);
            const deltaY = randomDelay(config.commentDeltaRange);
            await wheelAt(session, point.x, point.y, deltaY);
            scrolls.push({
              atMs: Date.now() - startedAt,
              deltaY,
              target: targetRect.ok ? targetRect.kind : "fallback-right-panel",
              point,
            });
          }
        }

        await blurActiveElement(session);
        const beforeNextUrl = await readLocationHref(session);
        const beforeNextAwemeId = await readCurrentAwemeId(session);
        await pressKey(session, config.nextKey);
        await sleep(config.afterNextWaitMs);
        const afterNextUrl = await readLocationHref(session);
        const afterNextAwemeId = await readCurrentAwemeId(session);
        const switched = didSwitchVideo({ beforeNextUrl, afterNextUrl, beforeNextAwemeId, afterNextAwemeId });

        cycles.push({
          index: cycleIndex,
          watchMs,
          scrollCount: scrolls.length,
          scrolls,
          nextKey: config.nextKey,
          beforeNextUrl,
          afterNextUrl,
          beforeNextAwemeId,
          afterNextAwemeId,
          switched,
        });
      }

      return {
        ok: true,
        initialUrl,
        finalUrl: await readLocationHref(session),
        config,
        beforeCommentsDelayMs,
        commentPanel,
        cycles,
      };
    } finally {
      session.close();
    }
  }

  async searchCycle(options = {}) {
    const terms = parseTerms(options.terms);
    const config = readSearchCycleConfig(options, terms.length);
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      await blurActiveElement(session);

      const initialUrl = await readLocationHref(session);
      const remainingTerms = [...terms];
      const usedTerms = [];
      const iterations = [];

      for (let index = 0; index < config.searches && remainingTerms.length > 0; index += 1) {
        const browseMs = config.searchFirst && index === 0 ? 0 : randomDelay(config.browseRange);
        const browse = browseMs > 0
          ? await browseVideosForDuration(session, browseMs, config)
          : { durationMs: 0, events: [], skipped: true };

        const term = removeRandomTerm(remainingTerms);
        usedTerms.push(term);
        const beforeSearchDelayMs = await sleepRandomStep(config, "before-search");
        const searchSurface = await ensureSearchSurface(session, config);
        const searchReady = searchSurface.ok
          ? {
              ok: true,
              attempts: searchSurface.attempts || 0,
              waitedMs: searchSurface.waitedMs || 0,
              searchBox: searchSurface.searchBox,
              method: searchSurface.method,
              normalizedUrl: searchSurface.normalizedUrl,
            }
          : await waitForSearchInputState(session, config.searchReadyTimeoutMs, config.stepDelayRange);

        const search = await searchVisibleBox(session, {
          term,
          candidates: terms,
          delayRange: config.searchDelayRange,
          stepDelayRange: config.stepDelayRange,
          searchReadyTimeoutMs: config.searchReadyTimeoutMs,
          submit: true,
        });

        const afterSearchDelayMs = await sleepRandomStep(config, "after-search");
        await sleep(config.afterSearchWaitMs);
        const afterSearchUrl = await readLocationHref(session);
        const openedVideo = config.openVideoAfterSearch && !/modal_id=/.test(afterSearchUrl)
          ? await openVisibleVideoFromResults(session, config.openVideoIndex, config.afterOpenVideoWaitMs, config)
          : { skipped: true, reason: /modal_id=/.test(afterSearchUrl) ? "already-in-video-modal" : "disabled" };

        iterations.push({
          index,
          browseMs,
          browse,
          beforeSearchDelayMs,
          searchReady,
          searchSurface,
          selectedTerm: term,
          usedTerms: [...usedTerms],
          remainingTerms: [...remainingTerms],
          search,
          afterSearchDelayMs,
          openedVideo,
        });
      }

      return {
        ok: true,
        initialUrl,
        finalUrl: await readLocationHref(session),
        config,
        terms,
        usedTerms,
        remainingTerms,
        exhausted: remainingTerms.length === 0,
        iterations,
      };
    } finally {
      session.close();
    }
  }

  async fullCycle(options = {}) {
    const terms = parseTerms(options.terms);
    const config = readSearchCycleConfig(options, terms.length);
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      await blurActiveElement(session);

      const initialUrl = await readLocationHref(session);
      const remainingTerms = [...terms];
      const usedTerms = [];
      const iterations = [];

      for (let index = 0; index < config.searches && remainingTerms.length > 0; index += 1) {
        const term = removeRandomTerm(remainingTerms);
        usedTerms.push(term);

        const beforeSearchDelayMs = await sleepRandomStep(config, "before-search");
        const searchSurface = await ensureSearchSurface(session, config);
        const searchReady = searchSurface.ok
          ? {
              ok: true,
              attempts: searchSurface.attempts || 0,
              waitedMs: searchSurface.waitedMs || 0,
              searchBox: searchSurface.searchBox,
              method: searchSurface.method,
              normalizedUrl: searchSurface.normalizedUrl,
            }
          : await waitForSearchInputState(session, config.searchReadyTimeoutMs, config.stepDelayRange);

        const search = await searchVisibleBox(session, {
          term,
          candidates: terms,
          delayRange: config.searchDelayRange,
          stepDelayRange: config.stepDelayRange,
          searchReadyTimeoutMs: config.searchReadyTimeoutMs,
          submit: true,
        });

        const afterSearchDelayMs = await sleepRandomStep(config, "after-search");
        await sleep(config.afterSearchWaitMs);
        const openedVideo = config.openVideoAfterSearch
          ? await openVisibleVideoFromResults(session, config.openVideoIndex, config.afterOpenVideoWaitMs, config)
          : { skipped: true, reason: "disabled" };

        const browseMs = randomDelay(config.browseRange);
        const afterOpenVideoDelayMs = openedVideo?.opened
          ? await sleepRandomStep(config, "after-open-video")
          : 0;
        const browse = openedVideo?.opened
          ? await browseVideosForDuration(session, browseMs, config)
          : { durationMs: browseMs, events: [], skipped: true, reason: "video-not-opened" };

        iterations.push({
          index,
          selectedTerm: term,
          beforeSearchDelayMs,
          searchReady,
          searchSurface,
          usedTerms: [...usedTerms],
          remainingTerms: [...remainingTerms],
          search,
          afterSearchDelayMs,
          openedVideo,
          afterOpenVideoDelayMs,
          browseMs,
          browse,
        });
      }

      const ok = iterations.length > 0 && iterations.every((iteration) =>
        iteration.search?.ok !== false &&
        (!config.openVideoAfterSearch || iteration.openedVideo?.opened === true)
      );
      return {
        ok,
        initialUrl,
        finalUrl: await readLocationHref(session),
        config,
        terms,
        usedTerms,
        remainingTerms,
        exhausted: remainingTerms.length === 0,
        iterations,
        failedIterationCount: iterations.filter((iteration) =>
          iteration.search?.ok === false ||
          config.openVideoAfterSearch && iteration.openedVideo?.opened !== true
        ).length,
      };
    } finally {
      session.close();
    }
  }

  async collectComments(options = {}) {
    const config = readCommentCollectConfig(options);
    const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
    const collectorConfig = {
      ...config,
      onEvent,
    };
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      const collector = createCommentNetworkCollector(session, collectorConfig);
      await session.send("Network.enable");
      await blurActiveElement(session);

      const startedAt = Date.now();
      const initialUrl = await readLocationHref(session);
      const awemeId = await readCurrentAwemeId(session);
      emitCollectEvent(onEvent, {
        event: "started",
        awemeId,
        url: initialUrl,
        maxComments: config.maxComments,
        timeoutMs: config.listenTimeoutMs,
        followVideos: config.followVideos,
      });
      const commentPanel = config.openComments
        ? await ensureCommentPanelOpen(session, config.commentOpenWaitMs)
        : { ok: false, skipped: true };
      emitCollectEvent(onEvent, {
        event: "comment-panel",
        ok: Boolean(commentPanel.ok),
        method: commentPanel.method || "",
        reason: commentPanel.reason || "",
      });

      const initialNetworkWait = config.openComments
        ? await waitForCollectorProgress(collector, {
            timeoutMs: commentPanel.method === "already-open" ? config.alreadyOpenInitialWaitMs : config.initialCommentWaitMs,
            baselinePageCount: 0,
            baselineCommentCount: 0,
          })
        : { ok: false, skipped: true };

      const scrolls = [];
      const deadline = Date.now() + config.listenTimeoutMs;
      let stopReason = "listen-timeout";
      let noNewCommentScrolls = 0;
      while (Date.now() < deadline) {
        await collector.drain();
        const snapshot = collector.snapshot();
        if (snapshot.pageCount >= config.maxPages) {
          stopReason = "max-pages";
          break;
        }
        if (snapshot.commentCount >= config.maxComments) {
          stopReason = "max-comments";
          break;
        }
        if (!config.followVideos && snapshot.hasMore === false && snapshot.pageCount > 0) {
          stopReason = "remote-has-more-false";
          break;
        }
        if (!config.followVideos && noNewCommentScrolls >= config.maxNoNewScrolls && snapshot.pageCount > 0) {
          stopReason = "no-new-comment-request-after-scroll";
          break;
        }

        const waitMs = Math.min(randomDelay(config.scrollIntervalRange), deadline - Date.now());
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        if (config.listenOnly) {
          emitCollectEvent(onEvent, {
            event: "listen",
            commentCount: snapshot.commentCount,
            pageCount: snapshot.pageCount,
            followVideos: config.followVideos,
          });
          continue;
        }

        const beforeScroll = collector.snapshot();
        const targetRect = await readCommentScrollTarget(session);
        const point = readScrollPoint(targetRect);
        const deltaY = randomDelay(config.scrollDeltaRange);
        const driver = await scrollCommentTarget(session, {
          targetRect,
          point,
          deltaY,
          mode: config.scrollDriver,
          fallbackAfter: config.domFallbackAfterNoNewScrolls,
          noNewCommentScrolls,
        });
        scrolls.push({
          index: scrolls.length,
          atMs: Date.now() - startedAt,
          deltaY,
          point,
          driver,
          target: targetRect.ok ? targetRect.kind : "fallback-right-panel",
          targetScroll: targetRect.scroll,
        });
        emitCollectEvent(onEvent, {
          event: "scroll",
          index: scrolls.length - 1,
          deltaY,
          target: targetRect.ok ? targetRect.kind : "fallback-right-panel",
          commentCount: beforeScroll.commentCount,
        });

        const afterScrollWaitMs = Math.min(config.afterScrollWaitMs, Math.max(0, deadline - Date.now()));
        if (afterScrollWaitMs > 0) {
          await sleep(afterScrollWaitMs);
        }
        await collector.drain();
        const afterScroll = collector.snapshot();
        if (afterScroll.pageCount > beforeScroll.pageCount || afterScroll.commentCount > beforeScroll.commentCount) {
          noNewCommentScrolls = 0;
        } else {
          noNewCommentScrolls += 1;
        }
      }

      await sleep(config.afterScrollWaitMs);
      await collector.drain();
      const snapshot = collector.snapshot();
      let domFallbackPanel = null;
      let domFallback = null;
      if (snapshot.commentCount === 0) {
        domFallbackPanel = commentPanel.ok
          ? commentPanel
          : config.openComments
            ? await ensureCommentPanelOpen(session, config.commentOpenWaitMs)
            : await readCommentScrollTarget(session);
        if (domFallbackPanel.ok) {
          await sleep(Math.min(350, config.afterScrollWaitMs));
          domFallback = await collectLoadedDomComments(session);
        } else {
          domFallback = {
            ok: false,
            reason: domFallbackPanel.reason || "DOM fallback 无法进入评论区",
            comments: [],
          };
        }
      }
      const domLocations = await collectVisibleCommentLocations(session).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      const networkComments = mergeDomLocations(snapshot.comments, domLocations?.comments || []);
      const domComments = snapshot.commentCount === 0
        ? [...(domFallback?.comments || []), ...(domLocations?.comments || [])]
        : [];
      const comments = mergeCollectedComments(networkComments, domComments, { awemeId });
      emitCollectEvent(onEvent, {
        event: "summary",
        ok: true,
        stopReason,
        elapsedMs: Date.now() - startedAt,
        commentCount: comments.length,
        pageCount: snapshot.pageCount,
        hasMore: snapshot.hasMore,
        totalReported: snapshot.totalReported,
      });

      return {
        ok: true,
        source: snapshot.commentCount > 0 ? "cdp-network-comment-list" : "dom-loaded-comments",
        target: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
        initialUrl,
        finalUrl: await readLocationHref(session),
        awemeId,
        config,
        commentPanel,
        initialNetworkWait,
        elapsedMs: Date.now() - startedAt,
        stopReason,
        noNewCommentScrolls,
        scrolls,
        network: {
          ...snapshot,
          comments: networkComments,
        },
        domFallback,
        domFallbackPanel,
        domLocations,
        comments,
      };
    } finally {
      session.close();
    }
  }

  async sendComment(options = {}) {
    const text = String(options.text || "").trim();
    if (!text) {
      throw new Error("评论内容为空");
    }

    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const waitMs = readDurationMs(options.afterSendWaitMs, options.afterSendWaitSec, 1_200);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");
      await blurActiveElement(session);
      const beforeUrl = await readLocationHref(session);
      const awemeId = await readCurrentAwemeId(session);
      const commentPanel = await ensureCommentPanelOpen(session, 1_200);
      if (!commentPanel.ok) {
        throw new Error(commentPanel.reason || "评论区未打开，无法发送评论");
      }

      const focused = await waitForCommentInputTarget(session, 3_500);
      if (!focused.ok) {
        throw new Error(focused.reason || "未找到可输入的评论框");
      }

      const outcomeBefore = await readCommentSubmissionOutcome(session, text).catch(() => ({
        ok: false,
        matchingCount: 0,
        composerValue: "",
      }));
      await clickAt(session, focused.click.x, focused.click.y);
      await sleep(120);
      await clearFocusedInput(session);
      await sleep(120);
      await session.send("Input.insertText", { text });
      await sleep(250);

      const inputAfterInsert = await readCommentInputTarget(session);
      if (!inputAfterInsert.ok || !String(inputAfterInsert.value || "").includes(text)) {
        throw new Error(inputAfterInsert.reason || "评论内容未写入右侧评论框");
      }

      const sendButton = await waitForCommentSendButtonTarget(session, 2_500);
      if (!sendButton.ok) {
        throw new Error(sendButton.reason || "未找到右侧评论框的红色发送按钮");
      }
      await clickAt(session, sendButton.click.x, sendButton.click.y);

      const submission = await waitForCommentSubmissionOutcome(session, text, outcomeBefore, waitMs);
      const confirmation = deriveSendConfirmation({
        inputWasPresent: true,
        inputBefore: inputAfterInsert.value || text,
        inputAfter: submission.composerValue || "",
        matchCountBefore: outcomeBefore.matchingCount,
        matchCountAfter: submission.matchingCount,
        blocked: submission.blocked,
      });
      const inputAfterSend = await readCommentInputTarget(session).catch(() => ({ ok: false, value: "" }));

      return {
        ok: confirmation.confirmed,
        sent: confirmation.sent,
        confirmed: confirmation.confirmed,
        awemeId,
        text,
        beforeUrl,
        afterUrl: await readLocationHref(session),
        target: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
        commentPanel,
        input: focused,
        inputAfterInsert,
        inputAfterSend,
        sendButton,
        outcomeBefore,
        submission,
        confirmation,
        submitMethod: "paired-red-send-button",
        inputCleared: confirmation.inputCleared,
        reason: confirmation.reason,
      };
    } finally {
      session.close();
    }
  }

  async currentVideo(options = {}) {
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Runtime.enable");
      const url = await readLocationHref(session);
      const awemeId = await readCurrentAwemeId(session);
      return {
        ok: Boolean(awemeId),
        awemeId,
        url,
        target: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
      };
    } finally {
      session.close();
    }
  }

  async inspectState(options = {}) {
    const host = options.host || DEFAULTS.remoteDebuggingHost;
    const port = Number(options.port || DEFAULTS.remoteDebuggingPort);
    const client = new DevtoolsClient(host, port);
    const target = await this.findDouyinPage(client);
    const session = new DevtoolsSession(target.webSocketDebuggerUrl);

    await session.connect();
    try {
      await session.send("Page.bringToFront");
      await session.send("Runtime.enable");

      const page = await readPageSummary(session);
      const searchBox = await readSearchInputState(session).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      const commentPanel = await readCommentScrollTarget(session).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      const videoCandidates = await readVideoCandidates(session).catch(() => []);
      const workflow = buildWorkflowAssessment({
        page,
        searchBox,
        commentPanel,
        videoCandidates,
      });

      return {
        ok: true,
        target: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
        page,
        searchBox,
        commentPanel,
        videoCandidateCount: videoCandidates.length,
        firstVideoCandidate: videoCandidates[0] || null,
        workflow,
      };
    } finally {
      session.close();
    }
  }

  async findDouyinPage(client) {
    let targets;
    try {
      targets = await client.listTargets();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法连接 Chrome 调试端口。请先执行 browser open，或确认端口参数正确。原始错误: ${message}`,
      );
    }
    const storedSession = readStoredBrowserSession();
    const matchingStoredSession = browserSessionMatchesClient(storedSession, client) ? storedSession : null;
    const preferredTargetId = matchingStoredSession?.target?.id || matchingStoredSession?.targetId || "";
    const douyinPage = selectDouyinTarget(targets, { preferredTargetId });
    if (douyinPage?.webSocketDebuggerUrl) {
      persistStoredTarget(douyinPage, matchingStoredSession);
      return douyinPage;
    }

    const target = await client.openUrl(DEFAULTS.douyinUrl);
    if (!target.webSocketDebuggerUrl) {
      throw new Error("没有找到可控制的抖音页面，请先执行 browser open。");
    }
    persistStoredTarget(target, matchingStoredSession);
    return target;
  }
}

function readStoredBrowserSession() {
  try {
    if (!fs.existsSync(DEFAULTS.sessionFile)) return null;
    return JSON.parse(fs.readFileSync(DEFAULTS.sessionFile, "utf8"));
  } catch {
    return null;
  }
}

function browserSessionMatchesClient(session, client) {
  if (!session || !client) return false;
  const sessionHost = session.remoteDebuggingHost || DEFAULTS.remoteDebuggingHost;
  const sessionPort = Number(session.remoteDebuggingPort || DEFAULTS.remoteDebuggingPort);
  return sessionHost === client.host && sessionPort === Number(client.port);
}

function persistStoredTarget(target, existingSession = null) {
  const session = existingSession || readStoredBrowserSession();
  if (!session || !target?.id) return;
  if (session.target?.id === target.id && session.target?.url === target.url) return;
  try {
    fs.writeFileSync(DEFAULTS.sessionFile, JSON.stringify({
      ...session,
      target: publicTarget(target),
      targetUpdatedAt: new Date().toISOString(),
    }, null, 2), "utf8");
  } catch {
    // Target persistence improves recovery but must not block an active CDP action.
  }
}

async function readPageSummary(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildPageSummaryExpression(),
    returnByValue: true,
  });
  return result.result?.value || {};
}


async function readVideoCandidates(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildVideoCandidatesExpression(),
    returnByValue: true,
  });
  return result.result?.value || [];
}

async function waitForVideoCandidates(session, timeoutMs, pollRange) {
  const startedAt = Date.now();
  let attempts = 0;
  let candidates = await readVideoCandidates(session);

  while (candidates.length === 0 && Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    await sleep(Math.min(randomDelay(pollRange), Math.max(0, remainingMs)));
    candidates = await readVideoCandidates(session);
  }

  return {
    ok: candidates.length > 0,
    attempts,
    waitedMs: Date.now() - startedAt,
    candidateCount: candidates.length,
    candidates,
  };
}

async function prepareVideoCandidateForClick(session, index) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildPrepareVideoCandidateForClickExpression(index),
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "未返回视频候选准备结果" };
}

async function clickVideoCandidateByDom(session, index) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildClickVideoCandidateByDomExpression(index),
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "DOM click 未返回结果" };
}

async function openVisibleVideoFromResults(session, index, waitMs, config = {}) {
  const ready = await waitForVideoCandidates(
    session,
    config.videoReadyTimeoutMs || 0,
    config.stepDelayRange || { min: 700, max: 1_200 },
  );
  const candidates = ready.candidates || await readVideoCandidates(session);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "搜索后未识别到可点击的视频结果",
      candidateCount: 0,
      ready,
      pageProblem: await readPageProblem(session).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      })),
    };
  }

  if (index >= candidates.length) {
    return {
      ok: false,
      reason: `视频 index 超出范围：${index}，当前只识别到 ${candidates.length} 个候选视频。`,
      candidateCount: candidates.length,
      ready,
    };
  }

  const prepared = await prepareVideoCandidateForClick(session, index);
  if (!prepared.ok) {
    return {
      ok: false,
      reason: prepared.reason || "视频候选卡片无法滚动到可点击位置",
      candidateCount: candidates.length,
      prepared,
    };
  }

  const selected = prepared.selected;
  const beforeState = await readPageSummary(session);
  const beforeUrl = beforeState.url || await readLocationHref(session);
  await clickAt(session, selected.click.x, selected.click.y);
  let afterState = await waitForVideoOpenState(session, waitMs);
  let afterUrl = afterState.url || await readLocationHref(session);
  let fallback = null;

  if (!isVideoActuallyOpen(afterState)) {
    fallback = await clickVideoCandidateByDom(session, index);
    afterState = await waitForVideoOpenState(session, waitMs);
    afterUrl = afterState.url || await readLocationHref(session);
  }

  const opened = isVideoActuallyOpen(afterState);

  return {
    ok: opened,
    index,
    candidateCount: prepared.candidateCount || candidates.length,
    selected,
    ready,
    prepared,
    fallback,
    beforeUrl,
    afterUrl,
    beforeState,
    afterState,
    opened,
    reason: opened ? "" : "点击已执行，但没有检测到视频详情页或视频浮层",
  };
}

async function waitForVideoOpenState(session, timeoutMs) {
  const startedAt = Date.now();
  const boundedTimeoutMs = Math.max(0, Number(timeoutMs || 0));
  let state = await readPageSummary(session);
  while (!isVideoActuallyOpen(state) && Date.now() - startedAt < boundedTimeoutMs) {
    await sleep(Math.min(200, Math.max(0, boundedTimeoutMs - (Date.now() - startedAt))));
    state = await readPageSummary(session);
  }
  return state;
}

async function browseVideosForDuration(session, durationMs, config) {
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  const events = [];
  const beforeCommentsDelayMs = config.openComments
    ? await sleepRandomStep(config, "before-open-comments")
    : 0;
  const commentPanel = config.openComments
    ? await ensureCommentPanelOpen(session, config.commentOpenWaitMs)
    : { ok: false, skipped: true };
  let nextCommentAt = Date.now() + randomDelay(config.commentIntervalRange);
  let nextVideoAt = Date.now() + randomDelay(config.watchRange);

  while (Date.now() < deadline) {
    const waitUntil = Math.min(nextCommentAt, nextVideoAt, deadline);
    const waitMs = waitUntil - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const now = Date.now();
    if (now >= deadline) {
      break;
    }

    if (config.scrollComments && now >= nextCommentAt) {
      const targetRect = await readCommentScrollTarget(session);
      const point = readScrollPoint(targetRect);
      const deltaY = randomDelay(config.commentDeltaRange);
      await wheelAt(session, point.x, point.y, deltaY);
      events.push({
        type: "comment-scroll",
        atMs: Date.now() - startedAt,
        deltaY,
        target: targetRect.ok ? targetRect.kind : "fallback-right-panel",
        point,
      });
      nextCommentAt = Date.now() + randomDelay(config.commentIntervalRange);
    }

    if (now >= nextVideoAt) {
      await blurActiveElement(session);
      const beforeNextUrl = await readLocationHref(session);
      const beforeNextAwemeId = await readCurrentAwemeId(session);
      await pressKey(session, config.nextKey);
      await sleep(config.afterNextWaitMs);
      const afterNextUrl = await readLocationHref(session);
      const afterNextAwemeId = await readCurrentAwemeId(session);
      const switched = didSwitchVideo({ beforeNextUrl, afterNextUrl, beforeNextAwemeId, afterNextAwemeId });
      events.push({
        type: "next-video",
        atMs: Date.now() - startedAt,
        nextKey: config.nextKey,
        beforeNextUrl,
        afterNextUrl,
        beforeNextAwemeId,
        afterNextAwemeId,
        switched,
      });
      nextVideoAt = Date.now() + randomDelay(config.watchRange);
    }
  }

  return {
    durationMs,
    actualDurationMs: Date.now() - startedAt,
    beforeCommentsDelayMs,
    commentPanel,
    events,
  };
}

async function ensureCommentPanelOpen(session, waitMs) {
  const before = await readCommentScrollTarget(session);
  if (before.ok) {
    return {
      ...before,
      method: "already-open",
    };
  }

  await blurActiveElement(session);
  await pressKey(session, "x");
  await sleep(waitMs);

  const afterKeyboard = await readCommentScrollTarget(session);
  if (afterKeyboard.ok) {
    return {
      ...afterKeyboard,
      method: "keyboard-x",
    };
  }

  const button = await readCommentButtonTarget(session);
  if (!button.ok) {
    return {
      ...afterKeyboard,
      method: "failed",
      keyboardAttempted: true,
      buttonAttempted: false,
      button,
    };
  }

  await clickAt(session, button.click.x, button.click.y);
  await sleep(waitMs);

  const afterButton = await readCommentScrollTarget(session);
  return {
    ...afterButton,
    method: afterButton.ok ? "comment-button" : "failed",
    keyboardAttempted: true,
    buttonAttempted: true,
    button,
  };
}

async function readCommentScrollTarget(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildCommentScrollTargetExpression(),
    returnByValue: true,
  });
  return result.result?.value || { ok: false };
}

async function readCommentButtonTarget(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildCommentButtonTargetExpression(),
    returnByValue: true,
  });
  return result.result?.value || { ok: false };
}

async function focusCommentInputTarget(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildFocusCommentInputTargetExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "评论输入框无返回" };
}

async function readCommentInputTarget(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildReadCommentInputTargetExpression(),
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "评论输入框状态无返回" };
}

async function waitForCommentInputTarget(session, timeoutMs) {
  const startedAt = Date.now();
  let candidate = await focusCommentInputTarget(session);
  while (!candidate?.ok && Date.now() - startedAt < timeoutMs) {
    await sleep(180);
    candidate = await focusCommentInputTarget(session);
  }
  return candidate || { ok: false, reason: "未找到右侧评论面板输入框" };
}

async function readCommentSendButtonTarget(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildCommentSendButtonTargetExpression(),
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "评论发送按钮无返回" };
}

async function waitForCommentSendButtonTarget(session, timeoutMs) {
  const startedAt = Date.now();
  let candidate = await readCommentSendButtonTarget(session);
  while (!candidate?.ok && Date.now() - startedAt < timeoutMs) {
    await sleep(160);
    candidate = await readCommentSendButtonTarget(session);
  }
  return candidate || { ok: false, reason: "未找到右侧评论框的红色发送按钮" };
}

async function readCommentSubmissionOutcome(session, text) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildCommentSubmissionOutcomeExpression(text),
    returnByValue: true,
  });
  return result.result?.value || {
    ok: false,
    matchingCount: 0,
    composerValue: "",
    reason: "评论发送结果无返回",
  };
}

async function waitForCommentSubmissionOutcome(session, text, baseline, timeoutMs) {
  const startedAt = Date.now();
  const boundedTimeoutMs = Math.max(0, Number(timeoutMs || 0));
  let outcome = await readCommentSubmissionOutcome(session, text);
  let confirmation = deriveSendConfirmation({
    inputWasPresent: true,
    inputBefore: text,
    inputAfter: outcome.composerValue || "",
    matchCountBefore: baseline?.matchingCount,
    matchCountAfter: outcome.matchingCount,
    blocked: outcome.blocked,
  });
  while (!confirmation.confirmed && !confirmation.blocked && Date.now() - startedAt < boundedTimeoutMs) {
    await sleep(Math.min(180, Math.max(0, boundedTimeoutMs - (Date.now() - startedAt))));
    outcome = await readCommentSubmissionOutcome(session, text);
    confirmation = deriveSendConfirmation({
      inputWasPresent: true,
      inputBefore: text,
      inputAfter: outcome.composerValue || "",
      matchCountBefore: baseline?.matchingCount,
      matchCountAfter: outcome.matchingCount,
      blocked: outcome.blocked,
    });
  }
  return {
    ...outcome,
    waitedMs: Date.now() - startedAt,
  };
}

function createCommentNetworkCollector(session, config) {
  const tracked = new Map();
  const tasks = new Set();
  const commentsById = new Map();
  const pages = [];
  const errors = [];
  const matchedRequests = [];
  let hasMore = null;
  let latestCursor = 0;
  let totalReported = null;
  let latestPageAt = 0;
  let latestMatchedRequestAt = 0;

  const trackRequest = (requestId, url, from) => {
    const type = classifyCommentUrl(url);
    if (!type) {
      return;
    }
    if (type === "reply-list" && !config.includeReplies) {
      return;
    }
    latestMatchedRequestAt = Date.now();
    if (tracked.has(requestId)) {
      const existing = tracked.get(requestId);
      existing.from = `${existing.from}+${from}`;
      return;
    }
    tracked.set(requestId, {
      requestId,
      type,
      url,
      urlInfo: summarizeCommentUrl(url, config.includeRawUrls),
      from,
      startedAt: Date.now(),
    });
    matchedRequests.push({
      requestId,
      type,
      urlInfo: summarizeCommentUrl(url, config.includeRawUrls),
      from,
      at: latestMatchedRequestAt,
    });
  };

  session.on("Network.requestWillBeSent", (params) => {
    const url = params.request?.url || "";
    trackRequest(params.requestId, url, "requestWillBeSent");
  });

  session.on("Network.responseReceived", (params) => {
    const url = params.response?.url || "";
    trackRequest(params.requestId, url, "responseReceived");
    const meta = tracked.get(params.requestId);
    if (meta) {
      meta.status = params.response?.status;
      meta.mimeType = params.response?.mimeType;
    }
  });

  session.on("Network.loadingFinished", (params) => {
    const meta = tracked.get(params.requestId);
    if (!meta) {
      return;
    }

    const task = processCommentResponse(params.requestId, meta)
      .catch((error) => {
        errors.push({
          requestId: params.requestId,
          urlInfo: meta.urlInfo,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        tasks.delete(task);
        tracked.delete(params.requestId);
      });
    tasks.add(task);
  });

  session.on("Network.loadingFailed", (params) => {
    const meta = tracked.get(params.requestId);
    if (!meta) {
      return;
    }
    errors.push({
      requestId: params.requestId,
      urlInfo: meta.urlInfo,
      error: params.errorText || "Network.loadingFailed",
    });
    tracked.delete(params.requestId);
  });

  async function processCommentResponse(requestId, meta) {
    const bodyResult = await session.send("Network.getResponseBody", { requestId });
    const rawText = bodyResult.base64Encoded
      ? Buffer.from(bodyResult.body || "", "base64").toString("utf8")
      : bodyResult.body || "";
    const data = JSON.parse(rawText);
    const rawComments = Array.isArray(data.comments) ? data.comments : [];
    const normalized = rawComments.map((comment) => normalizeComment(comment, meta));
    const newComments = [];

    for (const comment of normalized) {
      if (comment.comment_id && !commentsById.has(comment.comment_id)) {
        commentsById.set(comment.comment_id, comment);
        newComments.push(comment);
      }
    }

    hasMore = typeof data.has_more === "number" ? data.has_more === 1 : Boolean(data.has_more);
    latestCursor = data.cursor ?? latestCursor;
    totalReported = data.total ?? totalReported;
    latestPageAt = Date.now();
    const page = {
      index: pages.length,
      type: meta.type,
      requestId,
      status: meta.status,
      urlInfo: meta.urlInfo,
      count: normalized.length,
      cursor: data.cursor ?? null,
      hasMore,
      total: data.total ?? null,
      collectedUniqueCount: commentsById.size,
    };
    pages.push(page);
    emitCollectEvent(config.onEvent, {
      event: "page",
      page: {
        index: page.index,
        type: page.type,
        count: page.count,
        newCount: newComments.length,
        cursor: page.cursor,
        hasMore: page.hasMore,
        total: page.total,
        collectedUniqueCount: page.collectedUniqueCount,
        urlInfo: page.urlInfo,
      },
    });
    for (const comment of newComments) {
      emitCollectEvent(config.onEvent, {
        event: "comment",
        comment,
        page: {
          index: page.index,
          cursor: page.cursor,
        },
      });
    }
  }

  return {
    async drain() {
      if (tasks.size === 0) {
        return;
      }
      await Promise.allSettled([...tasks]);
    },
    snapshot() {
      const comments = [...commentsById.values()];
      return {
        ok: true,
        pageCount: pages.length,
        commentCount: comments.length,
        hasMore,
        nextCursor: latestCursor,
        totalReported,
        latestPageAt,
        latestMatchedRequestAt,
        trackedInFlight: tracked.size,
        pendingBodies: tasks.size,
        matchedRequestCount: matchedRequests.length,
        matchedRequests: matchedRequests.slice(-10),
        pages,
        errors,
        comments,
      };
    },
  };
}

async function waitForCollectorProgress(collector, options) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  const baselinePageCount = Number(options.baselinePageCount || 0);
  const baselineCommentCount = Number(options.baselineCommentCount || 0);
  const startedAt = Date.now();
  let snapshot = collector.snapshot();

  while (Date.now() - startedAt < timeoutMs) {
    await collector.drain();
    snapshot = collector.snapshot();
    if (snapshot.pageCount > baselinePageCount || snapshot.commentCount > baselineCommentCount) {
      return {
        ok: true,
        waitedMs: Date.now() - startedAt,
        pageCount: snapshot.pageCount,
        commentCount: snapshot.commentCount,
      };
    }
    await sleep(Math.min(300, Math.max(0, timeoutMs - (Date.now() - startedAt))));
  }

  await collector.drain();
  snapshot = collector.snapshot();
  return {
    ok: snapshot.pageCount > baselinePageCount || snapshot.commentCount > baselineCommentCount,
    waitedMs: Date.now() - startedAt,
    pageCount: snapshot.pageCount,
    commentCount: snapshot.commentCount,
    reason: "initial-comment-request-timeout",
  };
}

function emitCollectEvent(onEvent, payload) {
  if (typeof onEvent !== "function") {
    return;
  }

  try {
    onEvent({
      ts: new Date().toISOString(),
      ...payload,
    });
  } catch {
    // Streaming observers must not break collection.
  }
}


function didSwitchVideo({ beforeNextUrl, afterNextUrl, beforeNextAwemeId, afterNextAwemeId }) {
  if (beforeNextAwemeId && afterNextAwemeId) {
    return beforeNextAwemeId !== afterNextAwemeId;
  }
  return Boolean(beforeNextUrl && afterNextUrl && beforeNextUrl !== afterNextUrl);
}

async function readCurrentAwemeId(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const url = new URL(location.href);
      const modalId = url.searchParams.get('modal_id');
      if (modalId) return modalId;
      const videoMatch = location.pathname.match(/\\/video\\/(\\d+)/);
      if (videoMatch) return videoMatch[1];
      const text = document.documentElement.innerHTML || '';
      const modalMatch = text.match(/modal_id=(\\d+)/);
      if (modalMatch) return modalMatch[1];
      return '';
    })()`,
    returnByValue: true,
  });
  return result.result?.value || "";
}

async function collectLoadedDomComments(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const items = Array.from(document.querySelectorAll('[data-e2e="comment-item"]'));
      const comments = items.map((item, index) => {
        const userA = item.querySelector('a[href*="/user/"]');
        const rawHref = userA?.getAttribute('href') || '';
        const userLink = rawHref ? new URL(rawHref, location.origin).href.split('?')[0] : '';
        const secUid = userLink.match(/\\/user\\/([^/?#]+)/)?.[1] || '';
        return {
          source: 'dom-loaded-comments',
          index,
          user_nickname: userA?.innerText?.trim() || '',
          user_sec_uid: secUid,
          user_link: userLink,
          raw_text: item.innerText.trim(),
        };
      });
      return {
        ok: true,
        source: 'dom-loaded-comments',
        count: comments.length,
        comments,
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "DOM 评论提取无返回" };
}

async function collectVisibleCommentLocations(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildCollectVisibleCommentLocationsExpression(),
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "DOM 属地提取无返回" };
}


async function detectSearchBlocker(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildSearchBlockerExpression(),
    returnByValue: true,
  });
  return result.result?.value;
}

async function clearFocusedInput(session) {
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
}

async function readSearchInputState(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildReadSearchInputExpression(),
    returnByValue: true,
  });
  return result.result?.value;
}

async function waitForSearchInputState(session, timeoutMs, pollRange) {
  const startedAt = Date.now();
  let attempts = 0;
  let candidate = await readSearchInputState(session);

  while (!candidate?.ok && Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    await sleep(Math.min(randomDelay(pollRange), Math.max(0, remainingMs)));
    candidate = await readSearchInputState(session);
  }

  return {
    ok: Boolean(candidate?.ok),
    attempts,
    waitedMs: Date.now() - startedAt,
    searchBox: candidate,
    reason: candidate?.ok ? undefined : candidate?.reason || "未找到当前页面可见搜索框",
  };
}

async function ensureSearchSurface(session, config = {}) {
  const initial = await readSearchInputState(session).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (initial?.ok) {
    return { ok: true, method: "already-ready", searchBox: initial, waitedMs: 0, attempts: 0 };
  }

  const currentUrl = await readLocationHref(session);
  let normalizedUrl = null;
  try {
    const url = new URL(currentUrl);
    if (url.searchParams.has("modal_id")) {
      url.searchParams.delete("modal_id");
      normalizedUrl = url.href;
    }
  } catch {
    normalizedUrl = null;
  }

  if (normalizedUrl) {
    await session.send("Page.navigate", { url: normalizedUrl });
    const ready = await waitForSearchInputState(
      session,
      config.searchReadyTimeoutMs || 8_000,
      config.stepDelayRange || { min: 500, max: 1_000 },
    );
    return { ...ready, method: ready.ok ? "remove-modal-id" : "remove-modal-id-failed", normalizedUrl, beforeUrl: currentUrl };
  }

  return { ok: false, method: "not-normalized", searchBox: initial, reason: initial?.reason || "未找到当前页面可见搜索框", beforeUrl: currentUrl };
}

async function readPageProblem(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "(() => {\n  const bodyText = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();\n  const hasNetworkError = /网络出现问题|检查网络连接后重试|刷新/.test(bodyText);\n  const hasLoginBlocker = /登录|扫码|验证码|密码登录|login-full-panel/.test(bodyText);\n  return {\n    ok: true,\n    url: location.href,\n    title: document.title || '',\n    readyState: document.readyState,\n    hasNetworkError,\n    hasLoginBlocker,\n    reason: hasNetworkError ? '页面显示网络错误' : hasLoginBlocker ? '页面可能被登录层遮挡' : '',\n    counts: {\n      video: document.querySelectorAll('video').length,\n      img: document.querySelectorAll('img').length,\n      picture: document.querySelectorAll('picture').length,\n      canvas: document.querySelectorAll('canvas').length,\n      link: document.querySelectorAll('a[href]').length,\n    },\n    visibleTextSample: bodyText.slice(0, 500),\n  };\n})()",
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "页面诊断无返回" };
}

async function pressEnter(session) {
  await pressKey(session, "Enter");
}

async function readLocationHref(session) {
  const urlResult = await session.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
  });
  return urlResult.result?.value || "";
}

async function readSearchButtonRect(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildSearchButtonRectExpression(),
    returnByValue: true,
  });
  const value = result.result?.value;
  if (!value?.ok) {
    throw new Error(value?.reason || "未找到搜索按钮");
  }
  return value.rect;
}

async function searchVisibleBox(session, options) {
  const blocker = await detectSearchBlocker(session);
  if (blocker?.blocked) {
    throw new Error(blocker.reason);
  }

  const beforeInputDelayMs = randomDelay(options.delayRange);
  await sleep(beforeInputDelayMs);

  const ready = await waitForSearchInputState(
    session,
    options.searchReadyTimeoutMs || 0,
    options.stepDelayRange || options.delayRange,
  );
  const candidate = ready.searchBox;
  if (!candidate?.ok) {
    throw new Error(ready.reason || candidate?.reason || "未找到当前页面可见搜索框");
  }

  const clickPoint = readSearchClickPoint(candidate);
  await clickAt(session, clickPoint.x, clickPoint.y);
  await sleep(180);

  let focused = await focusVisibleSearchInput(session);
  if (!focused?.ok) {
    await clickAt(session, clickPoint.x, clickPoint.y);
    await sleep(220);
    focused = await focusVisibleSearchInput(session);
  }
  if (!focused?.ok) {
    throw new Error(focused?.reason || "搜索框聚焦失败");
  }

  await clearFocusedInput(session);
  await session.send("Input.insertText", { text: options.term });
  await sleep(120);

  let value = await readSearchInputState(session);
  if (!value?.ok || value.value !== options.term) {
    await setVisibleSearchInputValue(session, options.term);
    await sleep(120);
    value = await readSearchInputState(session);
  }
  if (!value?.ok || value.value !== options.term) {
    throw new Error(value?.reason || `搜索框输入失败，当前值: ${value?.value || ""}`);
  }

  const submit = options.submit !== false;
  const beforeSubmitDelayMs = submit ? randomDelay(options.delayRange) : 0;
  let afterSubmitUrl = await readLocationHref(session);
  let submitMethod = "none";
  if (submit) {
    const beforeSubmitUrl = await readLocationHref(session);
    await sleep(beforeSubmitDelayMs);
    const beforeSubmitBlocker = await detectSearchBlocker(session);
    if (beforeSubmitBlocker?.blocked) {
      throw new Error(beforeSubmitBlocker.reason);
    }

    await pressEnter(session);
    submitMethod = "enter";
    await sleep(1_200);
    afterSubmitUrl = await readLocationHref(session);

    if (afterSubmitUrl === beforeSubmitUrl) {
      const buttonRect = await readSearchButtonRect(session);
      await clickAt(session, buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2);
      submitMethod = "search-button-click";
      await sleep(1_500);
      afterSubmitUrl = await readLocationHref(session);
    }
  }

  return {
    ok: true,
    selectedTerm: options.term,
    candidates: options.candidates || [options.term],
    submitted: submit,
    submitMethod,
    delays: {
      beforeInputMs: beforeInputDelayMs,
      beforeSubmitMs: beforeSubmitDelayMs,
    },
    afterSubmitUrl,
    searchBox: value,
  };
}

async function focusVisibleSearchInput(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildFocusSearchInputExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value;
}

function readSearchClickPoint(searchBox) {
  const rect = searchBox.clickRect || searchBox.rect;
  return {
    x: Math.round(rect.x + rect.width * 0.46),
    y: Math.round(rect.y + rect.height / 2),
  };
}

async function setVisibleSearchInputValue(session, value) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildSetSearchInputValueExpression(value),
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value;
}

async function blurActiveElement(session) {
  await session.send("Runtime.evaluate", {
    expression: "(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()",
    returnByValue: true,
  });
}


async function sleepRandomStep(config, label) {
  if (!config?.stepDelayRange) {
    return 0;
  }
  const delayMs = randomDelay(config.stepDelayRange);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  return delayMs;
}

function randomDelay(range) {
  if (range.max === range.min) {
    return range.min;
  }
  return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

function selectRandomTerm(terms) {
  return terms[Math.floor(Math.random() * terms.length)];
}

function removeRandomTerm(terms) {
  const index = Math.floor(Math.random() * terms.length);
  const [term] = terms.splice(index, 1);
  return term;
}

function readScrollPoint(targetRect) {
  const viewportWidth = targetRect?.viewport?.width || 1400;
  const viewportHeight = targetRect?.viewport?.height || 900;
  if (targetRect?.ok && targetRect.rect) {
    const minX = Math.round(targetRect.rect.x + targetRect.rect.width * 0.35);
    const maxX = Math.round(targetRect.rect.x + targetRect.rect.width * 0.78);
    const minY = Math.round(targetRect.rect.y + Math.min(Math.max(targetRect.rect.height * 0.35, 130), 260));
    const maxY = Math.round(targetRect.rect.y + targetRect.rect.height - 90);
    return {
      x: clamp(
        randomInt(minX, Math.max(minX, maxX)),
        40,
        Math.max(40, viewportWidth - 40),
      ),
      y: clamp(
        randomInt(minY, Math.max(minY, maxY)),
        100,
        Math.max(100, viewportHeight - 80),
      ),
    };
  }

  return {
    x: Math.round(viewportWidth * 0.84),
    y: Math.round(viewportHeight * 0.62),
  };
}

async function scrollCommentTarget(session, options) {
  const mode = options.mode || "wheel";
  if (mode === "dom") {
    return await scrollCommentTargetByDom(session, options.deltaY);
  }

  await wheelAt(session, options.point.x, options.point.y, options.deltaY);
  if (mode !== "hybrid" || options.noNewCommentScrolls < options.fallbackAfter) {
    return {
      mode: "wheel",
      domFallbackUsed: false,
    };
  }

  const fallback = await scrollCommentTargetByDom(session, Math.round(options.deltaY * 0.7));
  return {
    mode: "hybrid",
    domFallbackUsed: true,
    fallback,
  };
}

async function scrollCommentTargetByDom(session, deltaY) {
  const result = await session.send("Runtime.evaluate", {
    expression: buildScrollCommentTargetByDomExpression(deltaY),
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value || { ok: false, reason: "DOM 滚动无返回" };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function randomInt(min, max) {
  const safeMin = Math.ceil(Math.min(min, max));
  const safeMax = Math.floor(Math.max(min, max));
  if (safeMax <= safeMin) {
    return safeMin;
  }
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function buildPageSummaryExpression() {
  return `(() => {
    const url = location.href;
    const bodyText = (document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ').trim();
    const inSearchPage = /\\/search\\//.test(location.pathname);
    const inVideoModal = /[?&]modal_id=/.test(location.search) ||
      /详情\\s*TA的作品\\s*评论|全部评论\\(\\d+\\)|留下你的精彩评论|清屏\\s*智能\\s*倍速/.test(bodyText);
    const title = document.title || '';
    const visibleTextSample = bodyText.slice(0, 300);

    return {
      url,
      title,
      pathname: location.pathname,
      search: location.search,
      inSearchPage,
      inVideoModal,
      visibleTextSample,
    };
  })()`;
}

function buildVideoCandidatesExpression() {
  return `(() => {
    ${buildVideoCandidateLibraryExpression()}
    return collectVideoCandidates().slice(0, 30).map(serializeVideoCandidate);
  })()`;
}

function buildPrepareVideoCandidateForClickExpression(index) {
  const safeIndex = readNonNegativeInt(index, 0);
  return `(async () => {
    ${buildVideoCandidateLibraryExpression()}
    const candidates = collectVideoCandidates();
    if (${safeIndex} >= candidates.length) {
      return {
        ok: false,
        reason: '视频 index 超出范围',
        candidateCount: candidates.length,
      };
    }

    const selected = candidates[${safeIndex}];
    selected.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    return {
      ok: true,
      method: 'scroll-into-view',
      candidateCount: candidates.length,
      selected: serializeVideoCandidate(selected, ${safeIndex}),
    };
  })()`;
}

function buildClickVideoCandidateByDomExpression(index) {
  const safeIndex = readNonNegativeInt(index, 0);
  return `(async () => {
    ${buildVideoCandidateLibraryExpression()}
    const candidates = collectVideoCandidates();
    if (${safeIndex} >= candidates.length) {
      return {
        ok: false,
        reason: '视频 index 超出范围',
        candidateCount: candidates.length,
      };
    }

    const selected = candidates[${safeIndex}];
    const target = selected.link || selected.element;
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    target.click();

    return {
      ok: true,
      method: 'dom-click',
      candidateCount: candidates.length,
      selected: serializeVideoCandidate(selected, ${safeIndex}),
    };
  })()`;
}

function buildVideoCandidateLibraryExpression() {
  return `
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);
    const normalizeText = (element) => (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
    const rectValue = (rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const isVisibleStyle = (element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.1;
    };
    const mediaElements = Array.from(document.querySelectorAll('video, img, picture, canvas'));

    const collectVideoCandidates = () => {
      const raw = [];
      mediaElements.forEach((media, order) => {
        if (!isVisibleStyle(media)) return;
        const mediaRect = media.getBoundingClientRect();
        if (mediaRect.width < 120 || mediaRect.height < 90) return;
        if (mediaRect.bottom < 120 || mediaRect.top > viewportHeight + 1400) return;
        if (mediaRect.right < 40 || mediaRect.left > viewportWidth - 40) return;

        let best = null;
        let node = media;
        for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) {
          if (!isVisibleStyle(node)) continue;
          const rect = node.getBoundingClientRect();
          const area = rect.width * rect.height;
          const text = normalizeText(node);
          const hasTime = /\\b\\d{1,2}:\\d{2}\\b/.test(text);
          const hasAuthor = /@/.test(text);
          const hasLike = /\\d+(\\.\\d+)?万|点赞|喜欢|收藏/.test(text);
          const badText = /开启读屏|搜索你感兴趣|为你生成回答|综合\\s+视频\\s+用户\\s+直播|多列|单列|筛选|相关搜索|展开查看更多/.test(text);
          const withinColumns =
            rect.width >= 170 &&
            rect.width <= Math.min(680, viewportWidth * 0.72) &&
            rect.height >= 130 &&
            rect.height <= Math.max(980, viewportHeight * 1.45) &&
            rect.bottom > 120 &&
            rect.top < viewportHeight + 1200 &&
            rect.right > 40 &&
            rect.left < viewportWidth - 40;

          if (!withinColumns || badText) continue;

          let score = 5;
          if (hasTime) score += 3;
          if (hasAuthor) score += 1;
          if (hasLike) score += 1;
          if (text.length >= 8 && text.length <= 260) score += 1;
          if (rect.top > 260) score += 1;
          if (rect.width >= 220 && rect.width <= 520) score += 1;
          if (rect.height >= 220 && rect.height <= 820) score += 1;
          if (area < 28_000) score -= 4;
          if (text.length > 360) score -= 3;

          const item = {
            element: node,
            link: node.closest('a[href], [role="link"]'),
            media,
            mediaRect,
            order,
            score,
            area,
            text,
            rect: rectValue(rect),
          };

          if (!best || item.score > best.score || (item.score === best.score && item.area > best.area)) {
            best = item;
          }
        }

        if (best && best.score >= 6) {
          raw.push(best);
        }
      });

      const deduped = [];
      for (const item of raw.sort((a, b) => b.score - a.score || a.area - b.area)) {
        const duplicate = deduped.some((other) => {
          return Math.abs(other.rect.x - item.rect.x) < 28 &&
            Math.abs(other.rect.y - item.rect.y) < 28 &&
            Math.abs(other.rect.width - item.rect.width) < 48 &&
            Math.abs(other.rect.height - item.rect.height) < 48;
        });
        if (!duplicate) {
          deduped.push(item);
        }
      }

      return deduped.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    };

    const serializeVideoCandidate = (item, index) => {
      const rect = item.element.getBoundingClientRect();
      const mediaRect = item.media?.getBoundingClientRect();
      const clickRect = mediaRect && mediaRect.width > 80 && mediaRect.height > 80 ? mediaRect : rect;
      const clickX = clampValue(Math.round(clickRect.left + clickRect.width / 2), 40, Math.max(40, viewportWidth - 40));
      const clickY = clampValue(Math.round(clickRect.top + clickRect.height / 2), 120, Math.max(120, viewportHeight - 40));
      return {
        index,
        score: item.score,
        text: item.text.slice(0, 120),
        rect: rectValue(rect),
        mediaRect: mediaRect ? rectValue(mediaRect) : null,
        click: {
          x: clickX,
          y: clickY,
        },
      };
    };
  `;
}

function buildCommentScrollTargetExpression() {
  return `(() => {
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const isVisible = (element, rect) => {
      const style = getComputedStyle(element);
      return rect.width >= 220 &&
        rect.height >= 120 &&
        rect.bottom > 80 &&
        rect.top < viewport.height &&
        rect.right > 0 &&
        rect.left < viewport.width &&
        rect.width <= viewport.width * 0.58 &&
        rect.height <= viewport.height * 1.2 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.1;
    };

    const addWithAncestors = (set, element, levels = 7) => {
      let current = element;
      let depth = 0;
      while (current && depth <= levels) {
        if (current instanceof HTMLElement) set.add(current);
        current = current.parentElement;
        depth += 1;
      }
    };

    const seeds = new Set();
    const semanticSelectors = [
      '[data-e2e="comment-list"]',
      '[data-e2e*="comment-list"]',
      '[data-e2e="comment-item"]',
      '[data-e2e*="comment-item"]',
      '[class*="comment-mainContent"]',
      '[class*="comment" i]',
    ];
    for (const selector of semanticSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        addWithAncestors(seeds, element);
      }
    }
    for (const element of document.querySelectorAll('div, aside, section, main')) {
      const rect = element.getBoundingClientRect();
      if (rect.left > viewport.width * 0.48 && rect.right > viewport.width * 0.76 && rect.height > 180) {
        const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/全部评论|留下你的精彩评论|展开\\d+条回复|回复/.test(text)) {
          seeds.add(element);
        }
      }
    }

    const scoreElement = (element, order) => {
      const rect = element.getBoundingClientRect();
      if (!isVisible(element, rect)) {
        return null;
      }

      const style = getComputedStyle(element);
      const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      const overflowY = style.overflowY;
      const scrollRange = Math.max(0, element.scrollHeight - element.clientHeight);
      const scrollable = scrollRange > 20 && overflowY !== 'visible' && overflowY !== 'clip';
      const dataE2e = element.getAttribute('data-e2e') || '';
      const className = String(element.className || '');
      const commentItemCount = element.querySelectorAll('[data-e2e="comment-item"], [data-e2e*="comment-item"]').length;
      const userLinkCount = element.querySelectorAll('a[href*="/user/"]').length;
      const rightPanelShape =
        rect.left > viewport.width * 0.45 &&
        rect.right > viewport.width * 0.72 &&
        rect.width >= 260 &&
        rect.width <= viewport.width * 0.54 &&
        rect.height >= viewport.height * 0.42 &&
        rect.height <= viewport.height * 1.1;
      const hasCommentSignal = /全部评论|留下你的精彩评论|评论\\(|评论\\d|评论|展开\\d+条回复|回复/.test(text);
      const semanticSignal = /comment/i.test(dataE2e) || /comment/i.test(className);
      if (!rightPanelShape || (!hasCommentSignal && !semanticSignal && commentItemCount === 0)) {
        return null;
      }

      let score = 0;
      if (dataE2e === 'comment-list') score += 35;
      if (/comment-mainContent/i.test(className)) score += 24;
      if (scrollable) score += 24;
      if (scrollRange > 160) score += 8;
      if (rightPanelShape) score += 10;
      if (commentItemCount >= 2) score += 14;
      if (userLinkCount >= 2) score += 8;
      if (/全部评论|留下你的精彩评论|评论\\(|评论\\d|评论/.test(text)) score += 7;
      if (/回复|展开\\d+条回复/.test(text)) score += 2;
      if (rect.height > viewport.height * 0.45) score += 2;
      if (rect.width > 320 && rect.width < viewport.width * 0.45) score += 1;
      if (!scrollable && scrollRange <= 20 && rect.top <= 10) score -= 12;
      if (rect.height < viewport.height * 0.28) score -= 8;
      if (/搜索你感兴趣的内容|综合|用户|直播|筛选|多列|单列/.test(text)) score -= 8;
      if (element === document.body || element === document.documentElement) score -= 50;

      return {
        order,
        score,
        scrollable,
        source: dataE2e || (className.match(/comment[^\\s]*/i)?.[0] || 'right-panel-text'),
        commentItemCount,
        userLinkCount,
        text,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        scroll: {
          top: Math.round(element.scrollTop),
          height: Math.round(element.scrollHeight),
          clientHeight: Math.round(element.clientHeight),
          range: Math.round(scrollRange),
          overflowY,
        },
      };
    };

    const candidates = Array.from(seeds)
      .map(scoreElement)
      .filter(Boolean)
      .filter((item) => item.score >= 9)
      .sort((a, b) =>
        Number(b.scrollable) - Number(a.scrollable) ||
        b.score - a.score ||
        b.scroll.range - a.scroll.range ||
        b.commentItemCount - a.commentItemCount ||
        b.rect.height - a.rect.height
      );

    const target = candidates[0];
    if (!target) {
      return {
        ok: false,
        reason: '未识别到评论区滚动容器',
        viewport,
      };
    }

    return {
      ok: true,
      kind: target.scrollable ? 'comment-scroll-container' : 'comment-panel',
      score: target.score,
      source: target.source,
      commentItemCount: target.commentItemCount,
      userLinkCount: target.userLinkCount,
      rect: target.rect,
      scroll: target.scroll,
      text: target.text.slice(0, 100),
      viewport,
      candidates: candidates.slice(0, 5).map((candidate) => ({
        score: candidate.score,
        source: candidate.source,
        scrollable: candidate.scrollable,
        commentItemCount: candidate.commentItemCount,
        rect: candidate.rect,
        scroll: candidate.scroll,
      })),
    };
  })()`;
}

function buildScrollCommentTargetByDomExpression(deltaY) {
  const safeDeltaY = Math.max(80, Math.min(900, Number(deltaY) || 300));
  return `new Promise((resolve) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const candidates = [];
    const add = (element) => {
      if (!(element instanceof HTMLElement)) return;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const scrollRange = Math.max(0, element.scrollHeight - element.clientHeight);
      const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      const rightPanelShape =
        rect.left > viewport.width * 0.45 &&
        rect.right > viewport.width * 0.72 &&
        rect.width >= 260 &&
        rect.height >= viewport.height * 0.36;
      if (!rightPanelShape || scrollRange <= 20 || style.display === 'none' || style.visibility === 'hidden') return;
      const dataE2e = element.getAttribute('data-e2e') || '';
      const className = String(element.className || '');
      const commentItemCount = element.querySelectorAll('[data-e2e="comment-item"], [data-e2e*="comment-item"], a[href*="/user/"]').length;
      let score = scrollRange;
      if (dataE2e === 'comment-list') score += 10000;
      if (/comment-mainContent/i.test(className)) score += 7000;
      if (commentItemCount >= 2) score += 3000;
      if (/全部评论|留下你的精彩评论|回复|展开\\d+条回复/.test(text)) score += 1000;
      candidates.push({ element, score, rect, scrollRange, dataE2e, commentItemCount });
    };
    for (const selector of ['[data-e2e="comment-list"]', '[data-e2e*="comment-list"]', '[class*="comment-mainContent"]', '[class*="comment" i]', 'div', 'aside', 'section']) {
      for (const element of document.querySelectorAll(selector)) add(element);
    }
    candidates.sort((a, b) => b.score - a.score);
    const target = candidates[0]?.element;
    if (!target) {
      resolve({ ok: false, reason: '未找到可 DOM 小步滚动的评论容器' });
      return;
    }
    const beforeTop = target.scrollTop;
    target.scrollBy({ top: ${safeDeltaY}, left: 0, behavior: 'smooth' });
    target.dispatchEvent(new Event('scroll', { bubbles: true }));
    setTimeout(() => {
      resolve({
        ok: true,
        mode: 'dom-small-scroll',
        deltaY: ${safeDeltaY},
        beforeTop,
        afterTop: target.scrollTop,
        scrollHeight: target.scrollHeight,
        clientHeight: target.clientHeight,
      });
    }, 350);
  })`;
}

function buildCollectVisibleCommentLocationsExpression() {
  return `(() => {
    const normalizeText = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    const extractLocation = (rawText) => {
      const text = normalizeText(rawText);
      const patterns = [
        /(?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前)\\s*·\\s*([^\\s·]+)/,
        /(?:昨天|前天)\\s*·\\s*([^\\s·]+)/,
        /\\d{1,2}月前\\s*·\\s*([^\\s·]+)/,
        /\\d{1,2}-\\d{1,2}\\s*·\\s*([^\\s·]+)/,
        /\\d{4}-\\d{1,2}-\\d{1,2}\\s*·\\s*([^\\s·]+)/,
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return match[1].trim();
      }
      return '';
    };
    const extractCommentText = (item, userName) => {
      const text = normalizeText(item.innerText || '');
      let cleaned = text;
      if (userName && cleaned.startsWith(userName)) {
        cleaned = cleaned.slice(userName.length).trim();
      }
      cleaned = cleaned
        .replace(/(?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前|昨天|前天)\\s*·\\s*[^\\s·]+.*$/u, '')
        .replace(/回复|分享|展开\\d+条回复|收起/u, ' ')
        .trim();
      return cleaned;
    };
    const items = Array.from(document.querySelectorAll('[data-e2e="comment-item"], [data-e2e*="comment-item"]'));
    const comments = items.map((item, index) => {
      const userA = item.querySelector('a[href*="/user/"]');
      const rawHref = userA?.getAttribute('href') || '';
      const userLink = rawHref ? new URL(rawHref, location.origin).href.split('?')[0] : '';
      const secUid = userLink.match(/\\/user\\/([^/?#]+)/)?.[1] || '';
      const rawText = item.innerText || '';
      const userName = userA?.innerText?.trim() || '';
      return {
        index,
        user_sec_uid: secUid,
        user_link: userLink,
        user_nickname: userName,
        raw_text: rawText,
        normalized_text: normalizeText(rawText),
        comment_text: extractCommentText(item, userName),
        comment_ip_location: extractLocation(rawText),
      };
    });
    return {
      ok: true,
      source: 'dom-visible-comment-locations',
      count: comments.length,
      withLocationCount: comments.filter((comment) => comment.comment_ip_location).length,
      comments,
    };
  })()`;
}

function buildCommentButtonTargetExpression() {
  return `(() => {
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const visibleRect = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = rect.width >= 10 &&
        rect.height >= 10 &&
        rect.bottom > 80 &&
        rect.top < viewport.height - 20 &&
        rect.right > viewport.width * 0.58 &&
        rect.left < viewport.width &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.1;

      if (!visible) {
        return null;
      }

      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };

    const describe = (element, source, score) => {
      const rect = visibleRect(element);
      if (!rect) {
        return null;
      }

      const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      const aria = element.getAttribute('aria-label') || '';
      const title = element.getAttribute('title') || '';
      const className = String(element.className || '');
      const combined = [text, aria, title, className].join(' ');

      let finalScore = score;
      if (/评论|comment/i.test(combined)) finalScore += 12;
      if (rect.x > viewport.width * 0.70) finalScore += 3;
      if (rect.width <= 130 && rect.height <= 150) finalScore += 2;
      if (/\\d+(\\.\\d+)?万?$/.test(text)) finalScore += 1;
      if (/赞|收藏|分享|头像|关注|作者|AI|弹幕|倍速|清屏/.test(combined)) finalScore -= 5;

      return {
        ok: true,
        source,
        score: finalScore,
        text: text.slice(0, 80),
        rect,
        click: {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        },
      };
    };

    const semanticSelectors = [
      '[aria-label*="评论"]',
      '[title*="评论"]',
      '[class*="comment" i]',
      '[data-e2e*="comment" i]',
      '[data-testid*="comment" i]'
    ];

    const semantic = semanticSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .map((element) => describe(element, 'semantic-comment-selector', 20))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0];

    if (semantic) {
      return semantic;
    }

    const numericActionGroups = Array.from(document.querySelectorAll('button, a, div, span'))
      .map((element) => {
        const rect = visibleRect(element);
        if (!rect) {
          return null;
        }

        const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
        const numberLike = /^\\d+(\\.\\d+)?万?$/.test(text);
        const compact = rect.width <= 120 && rect.height <= 110;
        if (!numberLike || !compact) {
          return null;
        }

        return {
          element,
          text,
          rect,
          click: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.rect.y - b.rect.y);

    const deduped = [];
    for (const item of numericActionGroups) {
      const duplicate = deduped.some((other) =>
        Math.abs(other.rect.y - item.rect.y) < 18 &&
        Math.abs(other.rect.x - item.rect.x) < 50
      );
      if (!duplicate) {
        deduped.push(item);
      }
    }

    if (deduped.length >= 2) {
      const target = deduped[1];
      return {
        ok: true,
        source: 'right-toolbar-second-number',
        score: 10,
        text: target.text,
        rect: target.rect,
        click: target.click,
        candidates: deduped.slice(0, 5).map((item) => ({
          text: item.text,
          rect: item.rect,
        })),
      };
    }

    return {
      ok: true,
      source: 'coordinate-fallback',
      score: 1,
      text: '',
      rect: {
        x: Math.round(viewport.width - 86),
        y: Math.round(viewport.height * 0.58),
        width: 72,
        height: 120,
      },
      click: {
        x: Math.round(viewport.width - 50),
        y: Math.round(viewport.height * 0.66),
      },
      viewport,
    };
  })()`;
}

function parseTerms(rawTerms) {
  const terms = String(rawTerms || "")
    .split(/[;；]/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    throw new Error("请通过 --terms 传入至少一个搜索词，例如：--terms \"恋爱;情感;日常\"");
  }
  return terms;
}

function buildSetSearchInputValueExpression(value) {
  return `(() => {
    ${buildSearchInputFinderSource()}
    const candidate = findVisibleSearchInput();
    if (!candidate) {
      return { ok: false, reason: '未找到当前页面可见搜索框' };
    }

    const input = candidate.element;
    const value = ${JSON.stringify(value)};
    input.focus();

    if ('value' in input) {
      const proto = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) {
        descriptor.set.call(input, value);
      } else {
        input.value = value;
      }
    } else {
      input.textContent = value;
    }

    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: value,
    }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      ...toPublicCandidate(candidate),
      value: readFieldValue(input),
      active: document.activeElement === input || input.contains(document.activeElement),
    };
  })()`;
}

function buildSearchInputFinderSource() {
  return `
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const toRect = (rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });

    const readFieldValue = (element) => {
      if ('value' in element) {
        return element.value || '';
      }
      return (element.innerText || element.textContent || '').trim();
    };

    const bodyText = (document.body.innerText || document.body.textContent || '').replace(/\\s+/g, ' ');
    const videoModalVisible = /详情\\s*TA的作品\\s*评论|全部评论\\(\\d+\\)|留下你的精彩评论|清屏\\s*智能\\s*倍速/.test(bodyText);

    const isVisible = (element, rect) => {
      const style = getComputedStyle(element);
      return rect.width >= 110 &&
        rect.height >= 22 &&
        rect.bottom > 0 &&
        rect.top < viewport.height - 80 &&
        rect.right > 0 &&
        rect.left < viewport.width &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.1;
    };

    const readHitInfo = (element, rect) => {
      const point = {
        x: Math.round(rect.left + rect.width * 0.46),
        y: Math.round(rect.top + rect.height / 2),
      };
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit) {
        return {
          reachable: false,
          point,
          reason: 'elementFromPoint 返回空',
        };
      }

      const direct = hit === element || element.contains(hit);
      const closestField = hit.closest?.('input, textarea, [contenteditable="true"]');
      const fieldMatched = closestField === element;
      const hitContainsInput = hit.contains(element);
      const hitRect = hit.getBoundingClientRect();
      const compactAncestor = hitContainsInput &&
        hitRect.width <= Math.max(rect.width * 2.8, rect.width + 180) &&
        hitRect.height <= Math.max(rect.height * 3.2, rect.height + 80);
      const reachable = direct || fieldMatched || compactAncestor;

      return {
        reachable,
        point,
        tagName: hit.tagName?.toLowerCase?.() || '',
        text: (hit.innerText || hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        className: String(hit.className || '').slice(0, 120),
        reason: reachable ? '' : '搜索框坐标被其他元素遮挡',
      };
    };

    const findCompactContainer = (element, button) => {
      if (!button) {
        return element;
      }

      let current = element.parentElement;
      const elementRect = element.getBoundingClientRect();
      while (current && current !== document.body && current !== document.documentElement) {
        const rect = current.getBoundingClientRect();
        if (
          current.contains(button.element) &&
          rect.width >= elementRect.width &&
          rect.width <= elementRect.width + 220 &&
          rect.height >= elementRect.height &&
          rect.height <= elementRect.height + 80
        ) {
          return current;
        }
        current = current.parentElement;
      }
      return element;
    };

    const searchButtons = Array.from(document.querySelectorAll('button, a, div, span'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
        const visible = text === '搜索' &&
          rect.width >= 28 &&
          rect.height >= 20 &&
          rect.bottom > 0 &&
          rect.top < viewport.height - 60 &&
          rect.right > 0 &&
          rect.left < viewport.width &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0.1;
        return visible ? { element, text, rect } : null;
      })
      .filter(Boolean);

    const findPairedSearchButton = (inputRect) => searchButtons
      .filter((button) => {
        const inputCenterY = inputRect.top + inputRect.height / 2;
        const buttonCenterY = button.rect.top + button.rect.height / 2;
        return Math.abs(buttonCenterY - inputCenterY) < 48 &&
          button.rect.left >= inputRect.left - 12 &&
          button.rect.left <= inputRect.right + 180;
      })
      .sort((a, b) => Math.abs(a.rect.left - inputRect.right) - Math.abs(b.rect.left - inputRect.right))[0] || null;

    const toPublicCandidate = (candidate) => {
      const container = candidate.container || candidate.element;
      const containerRect = container.getBoundingClientRect();
      return {
        ok: true,
        source: candidate.source,
        score: candidate.score,
        value: readFieldValue(candidate.element),
        placeholder: candidate.element.getAttribute('placeholder') || '',
        tagName: candidate.element.tagName.toLowerCase(),
        type: candidate.element.getAttribute('type') || '',
        rect: toRect(candidate.rect),
        clickRect: toRect(containerRect),
        buttonRect: candidate.button ? toRect(candidate.button.rect) : null,
        hit: candidate.hit,
        videoModalVisible: candidate.videoModalVisible,
      };
    };

    const findVisibleSearchInput = () => {
      const candidates = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
        .map((element, order) => {
          const rect = element.getBoundingClientRect();
          if (!isVisible(element, rect)) {
            return null;
          }

          const tagName = element.tagName.toLowerCase();
          const type = (element.getAttribute('type') || '').toLowerCase();
          if (tagName === 'input' && !['', 'text', 'search'].includes(type)) {
            return null;
          }

          const value = readFieldValue(element);
          const placeholder = element.getAttribute('placeholder') || '';
          const aria = element.getAttribute('aria-label') || '';
          const title = element.getAttribute('title') || '';
          const className = String(element.className || '');
          const combined = [value, placeholder, aria, title, className].join(' ');
          const button = findPairedSearchButton(rect);
          const hasSearchSignal = /搜索|感兴趣|search/i.test(combined);
          const hasInputBlockerSignal = /评论|弹幕|回复|留下|发送|私信|验证码|密码|手机号|登录/.test(combined);
          const hit = readHitInfo(element, rect);

          if (hasInputBlockerSignal && !hasSearchSignal && !button) {
            return null;
          }
          if (!hit.reachable) {
            return null;
          }

          let score = 0;
          if (hit.reachable) score += 15;
          if (button) score += 12;
          if (hasSearchSignal) score += 8;
          if (videoModalVisible && rect.left < viewport.width * 0.36 && rect.top >= 70 && rect.top <= 260) score += 30;
          if (videoModalVisible && rect.top < 70 && rect.left > viewport.width * 0.25) score -= 30;
          if (rect.top < 280) score += 5;
          if (rect.left < viewport.width * 0.72) score += 3;
          if (rect.width >= 180) score += 2;
          if (document.activeElement === element) score += 1;
          if (rect.bottom > viewport.height - 130) score -= 8;
          if (rect.top > 360 && !button) score -= 6;

          if (score < 7) {
            return null;
          }

          return {
            element,
            order,
            button,
            score,
            rect,
            hit,
            container: findCompactContainer(element, button),
            source: button ? 'visible-input-with-search-button' : 'visible-search-input',
            videoModalVisible,
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || a.rect.left - b.rect.left);

      return candidates[0] || null;
    };
  `;
}

function buildFocusSearchInputExpression() {
  return `(() => {
    ${buildSearchInputFinderSource()}
    const candidate = findVisibleSearchInput();
    if (!candidate) {
      return { ok: false, reason: '未找到当前页面可见搜索框' };
    }

    const input = candidate.element;
    input.focus();
    input.click();
    if (typeof input.select === 'function') {
      input.select();
    }
    const active = document.activeElement === input || input.contains(document.activeElement);

    return {
      ...toPublicCandidate(candidate),
      ok: active,
      active,
      reason: active ? undefined : '搜索框可见但聚焦失败'
    };
  })()`;
}

function buildReadSearchInputExpression() {
  return `(() => {
    ${buildSearchInputFinderSource()}
    const candidate = findVisibleSearchInput();
    if (!candidate) {
      return { ok: false, reason: '未找到当前页面可见搜索框' };
    }
    return toPublicCandidate(candidate);
  })()`;
}

function buildSearchButtonRectExpression() {
  return `(() => {
    ${buildSearchInputFinderSource()}
    const candidate = findVisibleSearchInput();
    if (!candidate) {
      return { ok: false, reason: '未找到搜索框，无法定位搜索按钮' };
    }
    if (!candidate.button) {
      return { ok: false, reason: '当前搜索框附近未找到搜索按钮' };
    }

    return {
      ok: true,
      text: candidate.button.text,
      rect: toRect(candidate.button.rect)
    };
  })()`;
}

function buildCommentComposerFinderSource() {
  return `
    const scoreCommentComposerCandidate = ${scoreCommentComposerCandidate.toString()};
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const toRect = (rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const visibleRect = (element) => {
      const rawRect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = rawRect.width >= 20 &&
        rawRect.height >= 18 &&
        rawRect.bottom > 0 &&
        rawRect.top < viewport.height &&
        rawRect.right > 0 &&
        rawRect.left < viewport.width &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0.1;
      return visible ? toRect(rawRect) : null;
    };
    const readValue = (element) => {
      const value = 'value' in element
        ? element.value || ''
        : element.innerText || element.textContent || '';
      return String(value).replace(/\\u200b/g, '').trim();
    };
    const readAncestorSignals = (element) => {
      let comment = false;
      let danmu = false;
      let current = element.parentElement;
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        if (current.id === 'merge-all-comment-container' ||
          current.classList?.contains('comment-input-container') ||
          current.classList?.contains('comment-input-inner-container')) {
          comment = true;
        }
        if (current.getAttribute?.('data-e2e') === 'danmaku-container' ||
          current.classList?.contains('danmakuContainer') ||
          current.classList?.contains('danmakuInputContainer')) {
          danmu = true;
        }
        const rect = current.getBoundingClientRect();
        const compactRightRegion = rect.left >= viewport.width * 0.48 &&
          rect.width <= viewport.width * 0.58 &&
          rect.height <= viewport.height * 0.96;
        if (!compactRightRegion) continue;
        const text = (current.innerText || current.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/全部评论|精彩评论|留下你的精彩评论|评论/.test(text)) comment = true;
        if (/弹幕|发一条友好的弹幕/.test(text)) danmu = true;
      }
      return { comment, danmu };
    };
    const publicComposer = (candidate) => ({
      ok: true,
      source: candidate.source,
      score: candidate.score,
      tagName: candidate.tagName,
      contentEditable: candidate.contentEditable,
      contentEditableMode: candidate.contentEditableMode,
      value: readValue(candidate.element),
      placeholder: candidate.placeholder,
      rect: candidate.rect,
      click: candidate.click,
      inRightZone: candidate.inRightZone,
      inCommentPanel: candidate.inCommentPanel,
    });
    const findCommentComposer = () => {
      const selectors = [
        'textarea',
        'input:not([type])',
        'input[type="text"]',
        '[contenteditable]:not([contenteditable="false"])',
        '[role="textbox"]'
      ];
      const commentRoots = Array.from(new Set([
        document.querySelector('#merge-all-comment-container'),
        ...document.querySelectorAll('.comment-input-container, .comment-input-inner-container'),
      ].filter(Boolean)));
      const anchoredElements = commentRoots.flatMap((root) => selectors.flatMap((selector) =>
        Array.from(root.matches?.(selector) ? [root] : root.querySelectorAll(selector))));
      const elements = Array.from(new Set([
        ...anchoredElements,
        ...selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))),
      ]));
      const candidates = elements.map((element, index) => {
        const rect = visibleRect(element);
        if (!rect) return null;
        const tagName = element.tagName.toLowerCase();
        const inputType = (element.getAttribute('type') || '').toLowerCase();
        const contentEditableMode = element.getAttribute('contenteditable');
        const editable = tagName === 'textarea' ||
          (tagName === 'input' && ['', 'text'].includes(inputType)) ||
          element.isContentEditable ||
          (contentEditableMode !== null && contentEditableMode !== 'false') ||
          element.getAttribute('role') === 'textbox';
        const text = readValue(element);
        const describedBy = element.getAttribute('aria-describedby') || '';
        const describedText = describedBy
          ? (document.getElementById(describedBy)?.innerText || document.getElementById(describedBy)?.textContent || '').trim()
          : '';
        const placeholder = element.getAttribute('placeholder') ||
          element.getAttribute('data-placeholder') ||
          element.getAttribute('aria-placeholder') ||
          describedText || '';
        const aria = element.getAttribute('aria-label') || '';
        const role = element.getAttribute('role') || '';
        const className = String(element.className || '');
        const signals = readAncestorSignals(element);
        const structurallyAnchored = commentRoots.some((root) => root === element || root.contains(element));
        const candidate = {
          visible: true,
          editable,
          tagName,
          contentEditable: element.isContentEditable || (contentEditableMode !== null && contentEditableMode !== 'false'),
          text,
          placeholder,
          aria,
          role,
          className,
          ancestorCommentSignal: signals.comment,
          ancestorDanmuSignal: signals.danmu,
          inCommentPanel: structurallyAnchored || signals.comment,
          active: document.activeElement === element || element.contains(document.activeElement),
          rect,
        };
        const score = scoreCommentComposerCandidate(candidate, viewport);
        if (score === null) return null;
        return {
          ...candidate,
          element,
          score,
          source: (structurallyAnchored ? 'anchored-draft-comment-editor:' : 'right-comment-editor:') + index,
          contentEditableMode: contentEditableMode || '',
          inRightZone: rect.left >= viewport.width * 0.66 && rect.right >= viewport.width * 0.82,
          click: {
            x: Math.round(rect.left + Math.min(Math.max(24, rect.width * 0.25), rect.width - 24)),
            y: Math.round(rect.top + rect.height / 2),
          },
        };
      }).filter(Boolean).sort((a, b) => b.score - a.score || b.rect.top - a.rect.top);
      return candidates[0] || null;
    };
  `;
}

export function buildFocusCommentInputTargetExpression() {
  return `new Promise((resolve) => {
    ${buildCommentComposerFinderSource()}
    const target = findCommentComposer();
    if (!target) {
      resolve({ ok: false, reason: '未找到右侧评论面板输入框；左侧弹幕框已排除', viewport });
      return;
    }
    target.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target.element.focus({ preventScroll: true });
    target.element.click();
    setTimeout(() => {
      const active = document.activeElement === target.element || target.element.contains(document.activeElement);
      resolve({
        ...publicComposer(target),
        ok: active,
        reason: active ? '' : '右侧评论输入框未获得焦点',
      });
    }, 100);
  })`;
}

export function buildReadCommentInputTargetExpression() {
  return `(() => {
    ${buildCommentComposerFinderSource()}
    const target = findCommentComposer();
    return target
      ? publicComposer(target)
      : { ok: false, reason: '未找到右侧评论面板输入框；左侧弹幕框已排除', viewport };
  })()`;
}

export function buildCommentSendButtonTargetExpression() {
  return `(() => {
    ${buildCommentComposerFinderSource()}
    const scoreCommentSendCandidate = ${scoreCommentSendCandidate.toString()};
    const composer = findCommentComposer();
    if (!composer) {
      return { ok: false, reason: '未找到右侧评论输入框，无法定位发送按钮', viewport };
    }
    const composerContainer = composer.element.closest('.comment-input-container') ||
      composer.element.closest('#merge-all-comment-container');
    const findCompactCommonContainer = (button) => {
      if (composerContainer) {
        return composerContainer.contains(button) ? composerContainer : null;
      }
      let current = composer.element;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const rect = current.getBoundingClientRect();
        const widthLimit = Math.min(viewport.width * 0.58, Math.max(composer.rect.width + 280, 380));
        if (current.contains(button) &&
          rect.width <= widthLimit &&
          rect.height <= 180 &&
          rect.bottom > viewport.height * 0.55) {
          return current;
        }
      }
      return null;
    };
    const readRedColor = (value) => {
      const rgb = String(value || '').match(/\\d+(?:\\.\\d+)?/g)?.slice(0, 3).map(Number) || [];
      return rgb.length === 3 && rgb[0] >= 180 && rgb[0] > rgb[1] * 1.45 && rgb[0] > rgb[2] * 1.15;
    };
    const readElementRed = (element) => {
      const style = getComputedStyle(element);
      return readRedColor(style.backgroundColor) || readRedColor(style.fill) || readRedColor(style.stroke);
    };
    const readRedVisual = (element) => {
      if (readElementRed(element)) {
        return { red: true, descendant: false, source: 'self-style' };
      }
      const redNode = Array.from(element.querySelectorAll('svg, path, circle, rect, polygon'))
        .find((node) => readElementRed(node));
      return redNode
        ? { red: true, descendant: true, source: 'descendant-svg-style' }
        : { red: false, descendant: false, source: '' };
    };
    const searchRoot = composerContainer || document;
    const elements = Array.from(new Set(Array.from(searchRoot.querySelectorAll(
      'button, [role="button"], [tabindex], span, div'
    ))));
    const candidates = elements.map((element, index) => {
      const rect = visibleRect(element);
      if (!rect) return null;
      const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      const aria = element.getAttribute('aria-label') || '';
      const title = element.getAttribute('title') || '';
      const role = element.getAttribute('role') || '';
      const className = String(element.className || '');
      const combined = [text, aria, title, className].join(' ');
      const style = getComputedStyle(element);
      const redVisual = readRedVisual(element);
      const red = redVisual.red;
      const sendSignal = /(^|\\s)发送($|\\s)|send/i.test(combined);
      if (!red && !sendSignal) return null;
      const commonContainer = findCompactCommonContainer(element);
      const candidate = {
        visible: true,
        disabled: element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled'),
        sameContainer: Boolean(commonContainer),
        red,
        redDescendant: redVisual.descendant,
        sendSignal,
        hasSvg: Boolean(element.querySelector('svg')),
        circle: Math.abs(rect.width - rect.height) <= 18 && rect.width >= 28 && rect.width <= 72,
        tagName: element.tagName.toLowerCase(),
        role,
        cursorPointer: style.cursor === 'pointer',
        danmuSignal: /弹幕|danmu|barrage/i.test(combined),
        rect,
      };
      const score = scoreCommentSendCandidate(candidate, composer, viewport);
      if (score === null) return null;
      return {
        ok: true,
        source: 'paired-red-comment-send:' + index,
        score,
        text: text.slice(0, 40),
        aria,
        red,
        redSource: redVisual.source,
        rect,
        composer: publicComposer(composer),
        click: {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        },
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score || b.rect.left - a.rect.left);
    return candidates[0] || {
      ok: false,
      reason: '右侧评论内容已输入，但未找到同一评论框内已激活的红色发送按钮',
      viewport,
      composer: publicComposer(composer),
    };
  })()`;
}

function buildCommentSubmissionOutcomeExpression(text) {
  const expectedText = JSON.stringify(String(text || ""));
  return `(() => {
    ${buildCommentComposerFinderSource()}
    const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const expected = normalize(${expectedText});
    const composer = findCommentComposer();
    const composerValue = composer
      ? (composer.element.isContentEditable
          ? (composer.element.innerText || composer.element.textContent || '')
          : String(composer.element.value || ''))
      : '';
    const items = Array.from(document.querySelectorAll(
      '[data-e2e="comment-item"], [data-e2e*="comment-item"], [class*="comment-item" i]'
    ));
    const matchingCount = items.filter((item) => expected && normalize(item.innerText || item.textContent).includes(expected)).length;
    const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const blocked = /评论失败|评论过于频繁|操作频繁|内容不符合|审核中|暂时无法评论|登录后评论/.test(bodyText);
    return {
      ok: true,
      composerPresent: Boolean(composer),
      composerValue,
      matchingCount,
      blocked,
      statusText: bodyText.match(/评论失败[^。\\n]*|评论过于频繁[^。\\n]*|操作频繁[^。\\n]*|审核中[^。\\n]*/)?.[0] || '',
    };
  })()`;
}

function buildSearchBlockerExpression() {
  return `(() => {
    ${buildSearchInputFinderSource()}
    const candidate = findVisibleSearchInput();
    if (!candidate) {
      return { blocked: false };
    }

    const input = candidate.element;
    const rect = candidate.rect;
    const points = [
      { name: 'search-input', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    ];
    if (candidate.button) {
      points.push({
        name: 'search-button',
        x: candidate.button.rect.left + candidate.button.rect.width / 2,
        y: candidate.button.rect.top + candidate.button.rect.height / 2
      });
    }

    for (const point of points) {
      const element = document.elementFromPoint(point.x, point.y);
      if (!element || element === input || input.contains(element) || element.contains(input)) {
        continue;
      }

      const text = (element.innerText || element.textContent || '').trim();
      const className = String(element.className || '');
      const id = element.id || '';
      const combined = [text, className, id].join(' ');
      if (/登录|扫码|验证码|密码登录|login-full-panel/.test(combined)) {
        return {
          blocked: true,
          point: point.name,
          reason: '抖音登录层正在遮挡搜索区域。当前自动化 Chrome 使用独立 Profile，不会自动继承你日常 Chrome 的登录态。请先在这个自动化 Chrome 中登录一次，或后续改用 attach/插件模式连接你的日常 Chrome。'
        };
      }
    }

    return { blocked: false };
  })()`;
}
