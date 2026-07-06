import type { ActionResult, BotEvent } from "@myfinal/shared";

/**
 * 传输模式
 * - ws     : 仅 WS（只收事件，无法发 action）
 * - http   : 仅 HTTP（只发 action，无法收事件）
 * - hybrid : WS 收事件 + HTTP 发 action（推荐）
 */
export type OneBotTransportMode = "ws" | "http" | "hybrid";

/**
 * WebSocket 连接配置
 */
export interface OneBotWsConfig {
  /** OneBot 正向 WS 地址，如 ws://127.0.0.1:6700 */
  url: string;
  /** 鉴权 token（对应 go-cqhttp access-token 配置） */
  accessToken?: string;
  /**
   * 客户端 ping 帧间隔（ms），用于维持 TCP 连接
   * @default 30000
   */
  heartbeatIntervalMs?: number;
  /**
   * 断线重连间隔（ms）
   * @default 5000
   */
  reconnectIntervalMs?: number;
  /**
   * WS 连接握手超时（ms）
   * @default 10000
   */
  connectTimeoutMs?: number;
}

/**
 * HTTP API 配置
 */
export interface OneBotHttpConfig {
  /** OneBot HTTP API 地址，如 http://127.0.0.1:5700 */
  baseUrl: string;
  /** 鉴权 token */
  accessToken?: string;
  /**
   * 单次请求超时（ms）
   * @default 5000
   */
  timeoutMs?: number;
}

/**
 * OneBotAdapter 配置
 */
export interface OneBotAdapterConfig {
  /** 机器人唯一标识（对应配置中的 botId，用于日志/事件 ID 生成） */
  botId: string;
  /** 传输模式 */
  mode: OneBotTransportMode;
  /** WS 配置（mode 为 ws 或 hybrid 时必填） */
  ws?: OneBotWsConfig;
  /** HTTP 配置（mode 为 http 或 hybrid 时必填） */
  http?: OneBotHttpConfig;
}

/**
 * 发往 OneBot 的 action 请求体
 */
export interface OneBotActionRequest<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  /** action 名称，如 send_group_msg / delete_msg */
  action: string;
  /** action 参数 */
  params?: TParams;
  /**
   * 请求标识，用于 WS 模式下匹配回调（HTTP 模式下无用）
   * 框架内部自动生成，调用方无需填写
   */
  echo?: string;
}

/** action 调用结果，alias 自 shared */
export type OneBotActionResponse<TData = unknown> = ActionResult<TData>;

/** 统一事件类型，alias 自 shared */
export type OneBotEvent = BotEvent;
