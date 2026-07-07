import type { ActionResult, BotEvent } from "@myfinal/shared";
import { OneBotHttpClient } from "./http-client.js";
import { OneBotWsClient } from "./ws-client.js";
import type { OneBotActionRequest, OneBotAdapterConfig } from "./types.js";

/**
 * OneBotAdapter —— 统一门面（Facade）
 *
 * 策略：
 * - 事件接入（ingress）：WebSocket（实时、低延迟）
 * - 动作发出（egress）：HTTP（可重试、超时可控）
 *
 * 上层（BotManager / MessageService）只与此类交互，
 * 不感知底层是 WS 还是 HTTP，也不接触 OneBot 原始字段。
 *
 * 使用示例：
 * ```ts
 * const adapter = new OneBotAdapter({
 *   botId: "bot1",
 *   mode: "hybrid",
 *   ws:   { url: "ws://127.0.0.1:6700", accessToken: "xxx" },
 *   http: { baseUrl: "http://127.0.0.1:5700", accessToken: "xxx" },
 * });
 *
 * adapter.onEvent(async (event) => {
 *   console.log("Received:", event.type, event.payload.text);
 * });
 *
 * await adapter.start();
 *
 * const result = await adapter.sendAction({
 *   action: "send_group_msg",
 *   params: { group_id: 123456, message: "hello" },
 * });
 * ```
 */
export class OneBotAdapter {
  private readonly wsClient?: OneBotWsClient;
  private readonly httpClient?: OneBotHttpClient;

  /** 事件处理回调（由上层注册） */
  private eventHandler?: (event: BotEvent) => Promise<void> | void;

  /**
   * @param config  适配器配置，需至少包含 ws 或 http 之一
   */
  constructor(private readonly config: OneBotAdapterConfig) {
    if (config.ws) {
      this.wsClient = new OneBotWsClient(config.botId, config.ws);
    }

    if (config.http) {
      this.httpClient = new OneBotHttpClient(config.http);
    }

    this._validateConfig();
  }

  // ---------------------------------------------------------------------------
  // 公共 API
  // ---------------------------------------------------------------------------

  /**
   * 注册事件回调
   * 来自 WS 的所有 BotEvent 都会投递到此回调
   * 必须在 start() 之前调用
   */
  onEvent(handler: (event: BotEvent) => Promise<void> | void): void {
    this.eventHandler = handler;
    // 将回调透传给 WS 客户端
    this.wsClient?.onEvent(handler);
  }

  /**
   * 启动适配器
   * - 建立 WS 连接（如果配置了 ws）
   * - HTTP 客户端无状态，无需初始化
   */
  async start(): Promise<void> {
    if (!this.wsClient) {
      console.warn(
        `[OneBotAdapter][${this.config.botId}] No WS config, event ingress disabled.`,
      );
      return;
    }

    console.info(
      `[OneBotAdapter][${this.config.botId}] Connecting to ${this.config.ws?.url}...`,
    );

    await this.wsClient.connect();

    console.info(
      `[OneBotAdapter][${this.config.botId}] WS connected. State=${this.wsClient.connectionState}`,
    );
  }

  /**
   * 停止适配器
   * - 主动关闭 WS 连接（不再自动重连）
   * - 清除事件回调
   */
  async stop(): Promise<void> {
    console.info(`[OneBotAdapter][${this.config.botId}] Stopping...`);
    await this.wsClient?.close();
    this.eventHandler = undefined;
    console.info(`[OneBotAdapter][${this.config.botId}] Stopped.`);
  }

  /**
   * 发送 OneBot action（走 HTTP）
   *
   * @param request  action 名称与参数
   * @returns        统一 ActionResult
   *
   * 常用 action 示例：
   * - send_private_msg  { user_id, message }
   * - send_group_msg    { group_id, message }
   * - delete_msg        { message_id }
   * - get_group_info    { group_id }
   */
  async sendAction<TData = unknown>(
    request: OneBotActionRequest,
  ): Promise<ActionResult<TData>> {
    if (!this.httpClient) {
      // HTTP 未配置时返回失败，不抛异常，由上层决定降级策略
      return {
        ok: false,
        status: "failed",
        message: `[OneBotAdapter][${this.config.botId}] HTTP transport not configured, cannot send action "${request.action}"`,
      };
    }

    return this.httpClient.request<TData>(request);
  }

  /**
   * 当前 WS 连接状态
   * undefined 表示未配置 WS
   */
  get wsState() {
    return this.wsClient?.connectionState;
  }

  get canSendAction(): boolean {
    return this.httpClient !== null;
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /**
   * 配置合法性检查
   * - hybrid 模式：ws + http 都必须配置
   * - ws 模式：必须有 ws
   * - http 模式：必须有 http（仅发送，无法接收事件）
   */
  private _validateConfig(): void {
    const { mode, ws, http, botId } = this.config;

    if (mode === "hybrid" && (!ws || !http)) {
      throw new Error(
        `[OneBotAdapter][${botId}] mode="hybrid" requires both ws and http config.`,
      );
    }
    if (mode === "ws" && !ws) {
      throw new Error(
        `[OneBotAdapter][${botId}] mode="ws" requires ws config.`,
      );
    }
    if (mode === "http" && !http) {
      throw new Error(
        `[OneBotAdapter][${botId}] mode="http" requires http config.`,
      );
    }
  }
}
