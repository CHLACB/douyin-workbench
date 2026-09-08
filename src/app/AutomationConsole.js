import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BrowserController } from "./BrowserController.js";
import { DouyinController } from "./DouyinController.js";

export class AutomationConsole {
  constructor(options = {}) {
    this.browserController = new BrowserController();
    this.douyinController = new DouyinController();
    this.options = {
      terms: options.terms || "情感;日常vlog;恋爱技巧",
      minWatchMs: options.minWatchMs || 120_000,
      maxWatchMs: options.maxWatchMs || 180_000,
      minBrowseMs: options.minBrowseMs || 120_000,
      maxBrowseMs: options.maxBrowseMs || 180_000,
      searches: options.searches || 2,
      cycles: options.cycles || 1,
      openVideoIndex: options.openVideoIndex || 0,
      port: options.port,
      host: options.host,
    };
  }

  async run() {
    const rl = readline.createInterface({ input, output });
    this.printWelcome();
    await this.printStatus();

    try {
      for (;;) {
        let line;
        try {
          line = (await rl.question("\ndouyin> ")).trim();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/readline was closed|closed/i.test(message)) {
            break;
          }
          throw error;
        }
        if (!line) {
          continue;
        }

        const shouldContinue = await this.handleCommand(line);
        if (!shouldContinue) {
          break;
        }
      }
    } finally {
      rl.close();
    }
  }

  printWelcome() {
    console.log("抖音自动化终端控制台");
    console.log("输入 help 查看命令，输入 next 执行建议的下一步，输入 quit 退出。");
  }

  async handleCommand(line) {
    const [command, ...rest] = line.split(/\s+/);
    const argText = rest.join(" ").trim();

    try {
      switch (command) {
        case "help":
        case "h":
          this.printHelp();
          return true;
        case "quit":
        case "exit":
        case "q":
          return false;
        case "status":
        case "s":
          await this.printStatus();
          return true;
        case "next":
        case "n":
          await this.runNext();
          return true;
        case "open":
          await this.openBrowser();
          return true;
        case "find-search":
        case "find":
          await this.printResult(await this.douyinController.findSearchBox(this.options));
          return true;
        case "search":
          await this.runSearch(argText);
          return true;
        case "open-video":
        case "video":
          await this.printResult(await this.douyinController.openVideo({
            ...this.options,
            index: this.options.openVideoIndex,
          }));
          return true;
        case "comments":
        case "comment":
          await this.printResult(await this.douyinController.openComments(this.options));
          return true;
        case "watch":
          await this.runWatch();
          return true;
        case "cycle":
        case "search-cycle":
          await this.runSearchCycle();
          return true;
        case "terms":
          this.setTerms(argText);
          return true;
        case "config":
          this.printConfig();
          return true;
        case "quick":
          this.setQuickMode();
          return true;
        default:
          console.log(`未知命令: ${command}`);
          this.printHelp();
          return true;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return true;
    }
  }

  printHelp() {
    console.log(`
命令:
  status / s           识别当前位置和下一步
  next / n             执行系统建议的下一步
  open                 打开自动化 Chrome 和抖音
  find-search / find   识别当前可用搜索框
  search [词1;词2]     用当前搜索框随机搜索一个词
  open-video / video   打开搜索结果里的第一个视频
  comments             打开评论区
  watch                刷评论区并切到下一个视频
  cycle                刷一会后换未用搜索词
  terms 词1;词2;词3    设置候选搜索词
  quick                把刷视频/换词等待改成 10-15 秒，方便测试
  config               查看当前控制台配置
  quit / q             退出控制台
`);
  }

  async printStatus() {
    const browserStatus = await this.browserController.status();
    if (!browserStatus.connected) {
      console.log("\n当前状态: Chrome 调试会话未连接");
      console.log("下一步: open");
      console.log(`原因: ${browserStatus.message || browserStatus.error || "请先打开浏览器"}`);
      return;
    }

    const state = await this.douyinController.inspectState(this.options);
    this.printState(state);
  }

  printState(state) {
    console.log("\n当前页面:");
    console.log(`  ${state.page.title}`);
    console.log(`  ${state.page.url}`);
    console.log(`当前位置: ${state.workflow.current}`);
    console.log("\n步骤:");
    for (const step of state.workflow.steps) {
      const marker = step.done ? "[x]" : "[ ]";
      console.log(`  ${marker} ${step.name}`);
    }
    console.log("\n识别:");
    console.log(`  搜索框: ${state.searchBox?.ok ? "可用" : "不可用"}`);
    console.log(`  视频候选: ${state.videoCandidateCount}`);
    console.log(`  评论区: ${state.commentPanel?.ok ? "已打开" : "未打开/未识别"}`);
    console.log("\n建议下一步:");
    console.log(`  ${state.workflow.nextAction.command} - ${state.workflow.nextAction.reason}`);
  }

  async runNext() {
    const browserStatus = await this.browserController.status();
    if (!browserStatus.connected) {
      await this.openBrowser();
      return;
    }

    const state = await this.douyinController.inspectState(this.options);
    const command = state.workflow.nextAction.command;
    console.log(`执行下一步: ${command}`);

    switch (command) {
      case "open":
        await this.openBrowser();
        break;
      case "search":
        await this.runSearch("");
        break;
      case "open-video":
        await this.printResult(await this.douyinController.openVideo({
          ...this.options,
          index: this.options.openVideoIndex,
        }));
        break;
      case "comments":
        await this.printResult(await this.douyinController.openComments(this.options));
        break;
      case "watch":
        await this.runWatch();
        break;
      case "find-search":
      case "status":
      default:
        await this.printStatus();
        break;
    }
  }

  async openBrowser() {
    const result = await this.browserController.open({
      port: this.options.port,
      host: this.options.host,
    });
    await this.printResult({
      ok: true,
      message: result.reused ? "Chrome 调试会话已存在" : "Chrome 已打开",
      url: result.url,
      remoteDebugging: `${result.remoteDebuggingHost}:${result.remoteDebuggingPort}`,
      sessionFile: result.sessionFile,
    });
  }

  async runSearch(argText) {
    const terms = argText || this.options.terms;
    const result = await this.douyinController.inputSearch({
      ...this.options,
      terms,
    });
    await this.printResult(result);
  }

  async runWatch() {
    const result = await this.douyinController.watchCycle({
      ...this.options,
      cycles: this.options.cycles,
      minWatchMs: this.options.minWatchMs,
      maxWatchMs: this.options.maxWatchMs,
    });
    await this.printResult(result);
  }

  async runSearchCycle() {
    const result = await this.douyinController.searchCycle({
      ...this.options,
      terms: this.options.terms,
      searches: this.options.searches,
      minBrowseMs: this.options.minBrowseMs,
      maxBrowseMs: this.options.maxBrowseMs,
      minWatchMs: this.options.minWatchMs,
      maxWatchMs: this.options.maxWatchMs,
    });
    await this.printResult(result);
  }

  setTerms(argText) {
    if (!argText) {
      console.log(`当前候选词: ${this.options.terms}`);
      return;
    }
    this.options.terms = argText;
    console.log(`候选词已设置: ${this.options.terms}`);
  }

  setQuickMode() {
    this.options.minWatchMs = 10_000;
    this.options.maxWatchMs = 15_000;
    this.options.minBrowseMs = 10_000;
    this.options.maxBrowseMs = 15_000;
    console.log("已切换 quick 模式：刷视频/换词等待 10-15 秒。");
  }

  printConfig() {
    console.log(JSON.stringify(this.options, null, 2));
  }

  async printResult(result) {
    console.log(JSON.stringify(result, null, 2));
  }
}
