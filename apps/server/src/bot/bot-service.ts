import type { LogService } from "@myfinal/logger";
import type { ConfigService } from "@myfinal/config";
import type { BotEvent } from "@myfinal/shared";
import { BotInstance } from "./bot-instance.js";

/**
 * BotService — 单机器人生命周期管理
 *
 * - 读取 bot.yaml 初始化唯一的 BotInstance
 * - 提供统一的 start / stop / reloadConfig
 */
export class BotService {
  private instance: BotInstance | null = null;
  private readonly log: ReturnType<LogService["child"]>;
  private lifecycleQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LogService,
    private readonly onEvent: (event: BotEvent) => Promise<void>
  ) {
    this.log = logger.child({ component: "BotService" });
  }

  async start(): Promise<void> {
    return this._enqueueLifecycle(() => this._start());
  }

  private async _start(): Promise<void> {
    const entry = this.config.bot;
    const enabled = entry.enabled !== false;

    if (!enabled) {
      this.log.info(`Bot "${entry.botId}" is disabled, skipping start`);
      return;
    }

    if (this.instance) {
      await this._stop();
    }

    this.log.info(`Starting bot "${entry.botId}"...`);

    this.instance = new BotInstance(entry, this.logger, this.onEvent);
    try {
      await this.instance.start();
      this.log.info(`Bot "${entry.botId}" started successfully`);
    } catch (err) {
      this.log.warn(
        `Bot "${entry.botId}" initial connect failed; will keep retrying in background`,
        { err: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  /** 获取当前 bot 的状态 */
  getBotState(): {
    botId: string;
    enabled: boolean;
    running: boolean;
    status:
      | "disabled"
      | "idle"
      | "connecting"
      | "connected"
      | "reconnecting"
      | "closed"
      | "no-ws";
  } {
    const entry = this.config.bot;
    const enabled = entry.enabled !== false;
    const status = !enabled
      ? ("disabled" as const)
      : (this.instance?.status ?? ("idle" as const));

    return {
      botId: entry.botId,
      enabled,
      running: !!this.instance,
      status,
    };
  }

  async stop(): Promise<void> {
    return this._enqueueLifecycle(() => this._stop());
  }

  private async _stop(): Promise<void> {
    this.log.info("Stopping bot...");
    if (this.instance) {
      const instance = this.instance;
      this.instance = null;
      await instance.stop();
    }
    this.log.info("Bot stopped");
  }

  async reloadConfig(): Promise<void> {
    return this._enqueueLifecycle(async () => {
      this.log.info("Reloading bot config...");
      await this._stop();
      await this._start();
    });
  }

  private _enqueueLifecycle(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycleQueue.then(work, work);
    this.lifecycleQueue = run.catch(() => undefined);
    return run;
  }

  getBot(): BotInstance | undefined {
    if (this.instance && !this.instance.canSendAction) return undefined;
    return this.instance ?? undefined;
  }
}
