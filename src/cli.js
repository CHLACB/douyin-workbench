#!/usr/bin/env node
import { BrowserController } from "./app/BrowserController.js";
import { DouyinController } from "./app/DouyinController.js";
import { AutomationConsole } from "./app/AutomationConsole.js";
import { buildCommentTerminalEvents } from "./app/douyin/commentStream.js";
import { actionExitCode } from "./app/cliOutcome.js";

function parseArgs(argv) {
  const args = {
    _: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function printHelp() {
  console.log(`
用法:
  node src/cli.js browser open [--url URL] [--port 9222] [--chrome-path PATH]
  node src/cli.js browser open --once
  node src/cli.js browser close [--force]
  node src/cli.js browser status
  node src/cli.js browser open-user-window --url URL [--timeout-sec 0]
  node src/cli.js browser send-private-message --url URL --text "私信内容"
  node src/cli.js douyin input-search --terms "恋爱;情感;日常" [--min-delay-ms 400] [--max-delay-ms 1200] [--no-submit]
  node src/cli.js douyin inspect
  node src/cli.js douyin find-search
  node src/cli.js douyin open-video [--index 0] [--after-click-wait-ms 1800]
  node src/cli.js douyin open-comments [--comment-open-wait-ms 1800]
  node src/cli.js douyin current-video
  node src/cli.js douyin send-comment --text "评论内容"
  node src/cli.js douyin watch-cycle [--cycles 1] [--min-watch-sec 120] [--max-watch-sec 180] [--min-step-delay-sec 3] [--max-step-delay-sec 7]
  node src/cli.js douyin search-cycle --terms "恋爱;情感;日常" [--searches 3] [--min-browse-sec 120] [--max-browse-sec 180] [--video-ready-timeout-sec 30]
  node src/cli.js douyin full-cycle --terms "恋爱;情感;日常" [--searches 3] [--min-browse-sec 120] [--max-browse-sec 180] [--min-step-delay-sec 3] [--max-step-delay-sec 7]
  node src/cli.js douyin collect-comments [--stream] [--follow-videos] [--listen-only] [--max-comments 120] [--listen-timeout-sec 60] [--scroll-driver wheel]
  node src/cli.js console [--terms "恋爱;情感;日常"]
  node src/cli.js doctor [--chrome-path PATH]

示例:
  npm run browser:open
  node .\\src\\cli.js browser open --url https://www.douyin.com/jingxuan
  node .\\src\\cli.js browser open-user-window --url https://www.douyin.com/user/example
  node .\\src\\cli.js browser send-private-message --url https://www.douyin.com/user/example --text "你好"
  node .\\src\\cli.js douyin inspect
  node .\\src\\cli.js douyin input-search --terms "恋爱;情感;日常"
  node .\\src\\cli.js douyin find-search
  node .\\src\\cli.js douyin open-video --index 0
  node .\\src\\cli.js douyin open-comments
  node .\\src\\cli.js douyin current-video
  node .\\src\\cli.js douyin send-comment --text "这个观点很有意思"
  node .\\src\\cli.js douyin watch-cycle --cycles 1
  node .\\src\\cli.js douyin search-cycle --terms "恋爱;情感;日常" --searches 2
  node .\\src\\cli.js douyin full-cycle --terms "恋爱;情感;日常" --searches 2
  node .\\src\\cli.js douyin collect-comments --stream --max-comments 300 --listen-timeout-sec 600 --scroll-driver wheel
  node .\\src\\cli.js console --terms "恋爱;情感;日常"
  npm run browser:status
`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printActionResult(value) {
  printJson(value);
  const exitCode = actionExitCode(value);
  if (exitCode > 0) process.exitCode = exitCode;
}

function printStreamEvent(value) {
  console.log(JSON.stringify(value));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [scope, action] = args._;
  const controller = new BrowserController();
  const douyinController = new DouyinController();

  if (!scope || args.help || args.h) {
    printHelp();
    return;
  }

  if (scope === "doctor") {
    printJson(await controller.doctor({
      chromePath: args["chrome-path"],
      host: args.host,
      port: args.port,
    }));
    return;
  }

  if (scope === "console") {
    const automationConsole = new AutomationConsole({
      terms: args.terms,
      searches: args.searches,
      cycles: args.cycles,
      minWatchMs: args["min-watch-ms"],
      maxWatchMs: args["max-watch-ms"],
      minBrowseMs: args["min-browse-ms"],
      maxBrowseMs: args["max-browse-ms"],
      openVideoIndex: args["open-video-index"],
      port: args.port,
      host: args.host,
    });
    await automationConsole.run();
    return;
  }

  if (scope === "douyin") {
    if (action === "inspect") {
      printJson(await douyinController.inspectState({
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "input-search") {
      printJson(await douyinController.inputSearch({
        terms: args.terms,
        port: args.port,
        host: args.host,
        minDelayMs: args["min-delay-ms"],
        maxDelayMs: args["max-delay-ms"],
        minStepDelaySec: args["min-step-delay-sec"],
        maxStepDelaySec: args["max-step-delay-sec"],
        searchReadyTimeoutSec: args["search-ready-timeout-sec"],
        submit: !args["no-submit"],
      }));
      return;
    }

    if (action === "find-search") {
      printJson(await douyinController.findSearchBox({
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "open-video") {
      printActionResult(await douyinController.openVideo({
        index: args.index,
        afterClickWaitMs: args["after-click-wait-ms"],
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "open-comments") {
      printJson(await douyinController.openComments({
        commentOpenWaitMs: args["comment-open-wait-ms"],
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "watch-cycle") {
      printJson(await douyinController.watchCycle({
        cycles: args.cycles,
        minWatchMs: args["min-watch-ms"],
        maxWatchMs: args["max-watch-ms"],
        minWatchSec: args["min-watch-sec"],
        maxWatchSec: args["max-watch-sec"],
        minStepDelaySec: args["min-step-delay-sec"],
        maxStepDelaySec: args["max-step-delay-sec"],
        commentScrollMinIntervalMs: args["comment-scroll-min-interval-ms"],
        commentScrollMaxIntervalMs: args["comment-scroll-max-interval-ms"],
        commentScrollMinIntervalSec: args["comment-scroll-min-interval-sec"],
        commentScrollMaxIntervalSec: args["comment-scroll-max-interval-sec"],
        commentScrollMinDelta: args["comment-scroll-min-delta"],
        commentScrollMaxDelta: args["comment-scroll-max-delta"],
        commentOpenWaitMs: args["comment-open-wait-ms"],
        commentOpenWaitSec: args["comment-open-wait-sec"],
        afterNextWaitMs: args["after-next-wait-ms"],
        afterNextWaitSec: args["after-next-wait-sec"],
        direction: args.direction,
        openComments: !args["no-open-comments"],
        scrollComments: !args["no-comment-scroll"],
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "search-cycle") {
      printJson(await douyinController.searchCycle({
        terms: args.terms,
        searches: args.searches,
        minBrowseMs: args["min-browse-ms"],
        maxBrowseMs: args["max-browse-ms"],
        minWatchMs: args["min-watch-ms"],
        maxWatchMs: args["max-watch-ms"],
        minBrowseSec: args["min-browse-sec"],
        maxBrowseSec: args["max-browse-sec"],
        minWatchSec: args["min-watch-sec"],
        maxWatchSec: args["max-watch-sec"],
        minStepDelaySec: args["min-step-delay-sec"],
        maxStepDelaySec: args["max-step-delay-sec"],
        searchReadyTimeoutSec: args["search-ready-timeout-sec"],
        videoReadyTimeoutSec: args["video-ready-timeout-sec"],
        minDelayMs: args["min-delay-ms"],
        maxDelayMs: args["max-delay-ms"],
        commentScrollMinIntervalMs: args["comment-scroll-min-interval-ms"],
        commentScrollMaxIntervalMs: args["comment-scroll-max-interval-ms"],
        commentScrollMinIntervalSec: args["comment-scroll-min-interval-sec"],
        commentScrollMaxIntervalSec: args["comment-scroll-max-interval-sec"],
        commentScrollMinDelta: args["comment-scroll-min-delta"],
        commentScrollMaxDelta: args["comment-scroll-max-delta"],
        commentOpenWaitMs: args["comment-open-wait-ms"],
        commentOpenWaitSec: args["comment-open-wait-sec"],
        afterNextWaitMs: args["after-next-wait-ms"],
        afterNextWaitSec: args["after-next-wait-sec"],
        afterSearchWaitMs: args["after-search-wait-ms"],
        afterSearchWaitSec: args["after-search-wait-sec"],
        afterOpenVideoWaitMs: args["after-open-video-wait-ms"],
        afterOpenVideoWaitSec: args["after-open-video-wait-sec"],
        openVideoIndex: args["open-video-index"],
        direction: args.direction,
        searchFirst: Boolean(args["search-first"]),
        openComments: !args["no-open-comments"],
        scrollComments: !args["no-comment-scroll"],
        openVideoAfterSearch: !args["no-open-video-after-search"],
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "full-cycle") {
      printActionResult(await douyinController.fullCycle({
        terms: args.terms,
        searches: args.searches,
        minBrowseMs: args["min-browse-ms"],
        maxBrowseMs: args["max-browse-ms"],
        minWatchMs: args["min-watch-ms"],
        maxWatchMs: args["max-watch-ms"],
        minBrowseSec: args["min-browse-sec"],
        maxBrowseSec: args["max-browse-sec"],
        minWatchSec: args["min-watch-sec"],
        maxWatchSec: args["max-watch-sec"],
        minStepDelaySec: args["min-step-delay-sec"],
        maxStepDelaySec: args["max-step-delay-sec"],
        searchReadyTimeoutSec: args["search-ready-timeout-sec"],
        videoReadyTimeoutSec: args["video-ready-timeout-sec"],
        minDelayMs: args["min-delay-ms"],
        maxDelayMs: args["max-delay-ms"],
        commentScrollMinIntervalMs: args["comment-scroll-min-interval-ms"],
        commentScrollMaxIntervalMs: args["comment-scroll-max-interval-ms"],
        commentScrollMinIntervalSec: args["comment-scroll-min-interval-sec"],
        commentScrollMaxIntervalSec: args["comment-scroll-max-interval-sec"],
        commentScrollMinDelta: args["comment-scroll-min-delta"],
        commentScrollMaxDelta: args["comment-scroll-max-delta"],
        commentOpenWaitMs: args["comment-open-wait-ms"],
        commentOpenWaitSec: args["comment-open-wait-sec"],
        afterNextWaitMs: args["after-next-wait-ms"],
        afterNextWaitSec: args["after-next-wait-sec"],
        afterSearchWaitMs: args["after-search-wait-ms"],
        afterSearchWaitSec: args["after-search-wait-sec"],
        afterOpenVideoWaitMs: args["after-open-video-wait-ms"],
        afterOpenVideoWaitSec: args["after-open-video-wait-sec"],
        openVideoIndex: args["open-video-index"],
        direction: args.direction,
        openComments: !args["no-open-comments"],
        scrollComments: !args["no-comment-scroll"],
        openVideoAfterSearch: !args["no-open-video-after-search"],
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "collect-comments") {
      const collectOptions = {
        maxPages: args["max-pages"],
        maxComments: args["max-comments"],
        includeReplies: Boolean(args["include-replies"]),
        includeRawUrls: Boolean(args["include-raw-urls"]),
        followVideos: Boolean(args["follow-videos"]),
        listenOnly: Boolean(args["listen-only"]),
        openComments: !args["no-open-comments"],
        commentOpenWaitMs: args["comment-open-wait-ms"],
        commentOpenWaitSec: args["comment-open-wait-sec"],
        initialCommentWaitMs: args["initial-comment-wait-ms"],
        initialCommentWaitSec: args["initial-comment-wait-sec"],
        alreadyOpenInitialWaitMs: args["already-open-initial-wait-ms"],
        alreadyOpenInitialWaitSec: args["already-open-initial-wait-sec"],
        listenTimeoutMs: args["listen-timeout-ms"],
        listenTimeoutSec: args["listen-timeout-sec"],
        afterScrollWaitMs: args["after-scroll-wait-ms"],
        afterScrollWaitSec: args["after-scroll-wait-sec"],
        maxNoNewScrolls: args["max-no-new-scrolls"],
        scrollDriver: args["scroll-driver"],
        domFallbackAfterNoNewScrolls: args["dom-fallback-after-no-new-scrolls"],
        minScrollIntervalMs: args["min-scroll-interval-ms"],
        maxScrollIntervalMs: args["max-scroll-interval-ms"],
        minScrollIntervalSec: args["min-scroll-interval-sec"],
        maxScrollIntervalSec: args["max-scroll-interval-sec"],
        minScrollDelta: args["min-scroll-delta"],
        maxScrollDelta: args["max-scroll-delta"],
        port: args.port,
        host: args.host,
      };

      if (args.stream) {
        const result = await douyinController.collectComments({
          ...collectOptions,
          onEvent: (event) => printStreamEvent(event),
        });
        for (const event of buildCommentTerminalEvents(result, {
          includeRawUrls: collectOptions.includeRawUrls,
        })) {
          printStreamEvent(event);
        }
      } else {
        printJson(await douyinController.collectComments(collectOptions));
      }
      return;
    }

    if (action === "send-comment") {
      printActionResult(await douyinController.sendComment({
        text: args.text,
        afterSendWaitMs: args["after-send-wait-ms"],
        afterSendWaitSec: args["after-send-wait-sec"],
        port: args.port,
        host: args.host,
      }));
      return;
    }

    if (action === "current-video") {
      printJson(await douyinController.currentVideo({
        port: args.port,
        host: args.host,
      }));
      return;
    }

    printHelp();
    return;
  }

  if (scope !== "browser") {
    throw new Error(`未知命令: ${scope}`);
  }

  if (action === "open") {
    const result = await controller.open({
      url: args.url,
      port: args.port,
      host: args.host,
      chromePath: args["chrome-path"],
      userDataDir: args["user-data-dir"],
    });
    printJson({
      ok: true,
      message: result.reused ? "Chrome 调试会话已存在" : "Chrome 已打开",
      pid: result.pid,
      url: result.url,
      remoteDebugging: `${result.remoteDebuggingHost}:${result.remoteDebuggingPort}`,
      browser: result.devtools.Browser,
      target: result.target
        ? {
            id: result.target.id,
            type: result.target.type,
            url: result.target.url,
          }
        : undefined,
      sessionFile: result.sessionFile,
    });
    if (!args.once) {
      await controller.monitor(result);
    }
    return;
  }

  if (action === "open-user-window") {
    printJson(await controller.openUserWindowAndWait({
      url: args.url,
      port: args.port,
      host: args.host,
      pollMs: args["poll-ms"],
      timeoutMs: args["timeout-ms"],
      timeoutSec: args["timeout-sec"],
    }));
    return;
  }

  if (action === "send-private-message") {
    printActionResult(await controller.sendPrivateMessage({
      url: args.url,
      text: args.text,
      port: args.port,
      host: args.host,
      timeoutMs: args["timeout-ms"],
      timeoutSec: args["timeout-sec"],
      afterPrivateClickMs: args["after-private-click-ms"],
      afterSendWaitMs: args["after-send-wait-ms"],
      afterSendWaitSec: args["after-send-wait-sec"],
    }));
    return;
  }

  if (action === "status") {
    printJson(await controller.status());
    return;
  }

  if (action === "close") {
    printActionResult(await controller.close({
      force: Boolean(args.force),
      port: args.port,
      host: args.host,
    }));
    return;
  }

  printHelp();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
