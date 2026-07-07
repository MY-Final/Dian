import type { OneBotAdapter, OneBotActionRequest } from "@myfinal/sdk";
import type { ActionResult, BotEvent } from "@myfinal/shared";
import type { LogService } from "@myfinal/logger";
import type { BotEntry } from "@myfinal/config";
import { OneBotAdapter as Adapter } from "@myfinal/sdk";

/**
 * 单个 Bot 实例，持有独立的 Adapter 和日志上下文
 */
export class BotInstance {
  readonly botId: string;
  private readonly adapter: OneBotAdapter;
  private readonly log: ReturnType<LogService["child"]>;

  constructor(
    entry: BotEntry,
    logger: LogService,
    private readonly onEvent: (event: BotEvent) => Promise<void>
  ) {
    this.botId = entry.botId;
    this.log = logger.child({ bot: entry.botId });

    this.adapter = new Adapter({
      botId: entry.botId,
      mode: entry.mode,
      ws: entry.ws,
      http: entry.http,
    });

    this.adapter.onEvent(async (event) => {
      try {
        await this.onEvent(event);
      } catch (err) {
        this.log.error("Event handler threw an error", { err });
      }
    });
  }

  async start(): Promise<void> {
    this.log.info("Starting bot...");
    await this.adapter.start();
    this.log.info("Bot started");
  }

  /**
   * 当前连接状态
   * - 有 WS 配置时：返回 WS 状态（idle / connecting / connected / reconnecting / closed）
   * - 仅 HTTP 模式：返回 "no-ws"（无事件接入但可下发动作）
   */
  get status(): "idle" | "connecting" | "connected" | "reconnecting" | "closed" | "no-ws" {
    return this.adapter.wsState ?? "no-ws";
  }

  get canSendAction(): boolean {
    return this.adapter.canSendAction;
  }

  async stop(): Promise<void> {
    this.log.info("Stopping bot...");
    await this.adapter.stop();
    this.log.info("Bot stopped");
  }

  async sendAction<TData = unknown>(
    request: OneBotActionRequest,
  ): Promise<ActionResult<TData>> {
    return this.adapter.sendAction<TData>(request);
  }
}
