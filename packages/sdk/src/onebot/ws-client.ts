import { WebSocket } from "ws";
import type { BotEvent, OneBotRawEvent } from "@myfinal/shared";
import { mapOneBotEvent } from "@myfinal/shared";
import type { OneBotWsConfig } from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/** WS 客户端的连接状态 */
export type WsState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

/** 事件回调类型 */
export type OneBotEventHandler = (event: BotEvent) => Promise<void> | void;

/**
 * OneBot v11 正向 WebSocket 客户端
 *
 * 职责：
 * - 建立并维持到 OneBot 实现（如 go-cqhttp）的 WS 长连接
 * - 维持心跳（若服务端不主动发心跳包则客户端定时 ping）
 * - 连接断开后按配置间隔自动重连
 * - 将上报的原始 JSON 解析并映射为统一 BotEvent 投递给上层
 *
 * 使用示例：
 * ```ts
 * const client = new OneBotWsClient("bot1", { url: "ws://127.0.0.1:6700" });
 * client.onEvent(async (event) => { ... });
 * await client.connect();
 * ```
 */
export class OneBotWsClient {
  private ws: WebSocket | null = null;
  private state: WsState = "idle";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  /** 是否主动关闭（主动关闭时不再重连） */
  private manualClose = false;
  private handler?: OneBotEventHandler;

  /**
   * @param botId   机器人标识，用于生成 eventId 和日志上下文
   * @param config  WS 连接配置
   */
  constructor(
    private readonly botId: string,
    private readonly config: OneBotWsConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // 公共 API
  // ---------------------------------------------------------------------------

  /**
   * 注册事件回调
   * 每次收到来自 OneBot 的上报事件（message/notice/request/meta）都会调用此回调
   */
  onEvent(handler: OneBotEventHandler): void {
    this.handler = handler;
  }

  /** 当前连接状态 */
  get connectionState(): WsState {
    return this.state;
  }

  /**
   * 建立 WebSocket 连接
   * 若已连接则直接返回
   */
  async connect(): Promise<void> {
    if (this.state === "connected") return;
    if (this.state === "connecting") return this.connectPromise ?? Promise.resolve();

    this.manualClose = false;
    const promise = this._doConnect();
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }

  /**
   * 主动关闭连接，不再重连
   */
  async close(): Promise<void> {
    this.manualClose = true;
    this._clearTimers();

    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.state = "closed";
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        resolve();
      }, DEFAULT_CLOSE_TIMEOUT_MS);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      ws.once("close", finish);
      ws.once("error", finish);

      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else {
        ws.terminate();
      }
    });

    this.state = "closed";
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  /**
   * 核心连接逻辑
   * 每次（包括重连）都通过此方法创建新的 WebSocket 实例
   */
  private _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = this.state === "reconnecting" ? "reconnecting" : "connecting";

      const headers: Record<string, string> = {};
      if (this.config.accessToken) {
        // OneBot 鉴权：Authorization 头部携带 Bearer token
        headers["Authorization"] = `Bearer ${this.config.accessToken}`;
      }

      const ws = new WebSocket(this.config.url, { headers });
      this.ws = ws;

      let settled = false;
      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error(`WebSocket connect timeout after ${this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS}ms`));
      }, this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        fn();
      };

      ws.once("open", () => {
        settle(() => {
          this.state = "connected";
          this._startHeartbeat();
          resolve();
        });
      });

      ws.once("error", (err) => {
        settle(() => reject(err));
      });

      ws.on("message", (data) => {
        this._handleMessage(data.toString());
      });

      ws.once("close", (code, reason) => {
        clearTimeout(connectTimeout);
        this._stopHeartbeat();
        settle(() => reject(new Error(`WebSocket closed before open code=${code} reason=${reason.toString()}`)));
        if (this.ws !== ws) return;
        this.ws = null;
        this.state = "idle";

        if (!this.manualClose) {
          // 非主动关闭：进入重连流程
          this._scheduleReconnect();
        }

        // 日志占位（后续替换为 LogService）
        console.warn(
          `[OneBotWsClient][${this.botId}] WS closed code=${code} reason=${reason.toString()}`,
        );
      });
    });
  }

  /**
   * 解析并分发收到的 WS 消息
   * 非 JSON 或格式不符预期时静默丢弃（避免因脏数据崩溃）
   */
  private _handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 非 JSON 数据，忽略（OneBot 标准上报都是 JSON）
      return;
    }

    // OneBot 上报包含 post_type 字段，action 回调包含 echo 字段
    // 这里只处理事件上报，action 回调走 http，不走 ws
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("post_type" in parsed)
    ) {
      return;
    }

    const rawEvent = parsed as OneBotRawEvent;

    // 元事件（心跳）不投递给业务层，仅用于连接保活确认
    if (rawEvent.post_type === "meta_event") {
      return;
    }

    const event = mapOneBotEvent(this.botId, rawEvent);
    void this.handler?.(event);
  }

  /**
   * 启动客户端心跳
   * OneBot 服务端会主动发心跳 meta_event；
   * 这里额外用 WS ping 帧维持 TCP 连接，防止中间网络设备切断空闲连接
   */
  private _startHeartbeat(): void {
    const intervalMs = this.config.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, intervalMs);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 调度重连
   * 采用固定间隔（非指数退避），简单可预期
   */
  private _scheduleReconnect(): void {
    const delay = this.config.reconnectIntervalMs ?? 5_000;
    this.state = "reconnecting";

    console.info(
      `[OneBotWsClient][${this.botId}] Reconnecting in ${delay}ms...`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._doConnect().catch((err) => {
        console.error(`[OneBotWsClient][${this.botId}] Reconnect failed:`, err);
      });
    }, delay);
  }

  private _clearTimers(): void {
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
