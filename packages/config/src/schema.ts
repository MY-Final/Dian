import { z } from "zod";

// ---------------------------------------------------------------------------
// settings.yaml
// ---------------------------------------------------------------------------

export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const StorageSchema = z.object({
  /** SQLite 数据库文件路径，相对于项目根目录 */
  sqlite: z.string().optional(),
  /** MySQL 连接字符串，如 mysql://user:pass@host:3306/db */
  mysql: z.string().optional(),
  /** Redis 连接字符串，如 redis://localhost:6379 */
  redis: z.string().optional(),
});

export const AuthSchema = z.object({
  /** 密码的 bcrypt 哈希值 */
  passwordHash: z.string().optional(),
  /** JWT 密钥，留空则自动生成随机串 */
  jwtSecret: z.string().optional(),
  /** Token 有效期（秒），默认 86400 (24h) */
  tokenExpiresIn: z.number().int().positive().optional(),
});

export type AuthConfig = z.infer<typeof AuthSchema>;

export const SettingsSchema = z.object({
  /** 日志级别，默认 info */
  logLevel: LogLevelSchema.default("info"),
  /** 存储连接配置 */
  storage: StorageSchema.default({}),
  /** 认证配置 */
  auth: AuthSchema.default({}),
  /** HTTPS 代理地址，如 http://192.168.1.1:7890 */
  httpsProxy: z.string().optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// bot.yaml
// ---------------------------------------------------------------------------

export const OneBotWsConfigSchema = z.object({
  /** OneBot 正向 WS 地址，如 ws://127.0.0.1:6700 */
  url: z.string().url(),
  /** 鉴权 token */
  accessToken: z.string().optional(),
  /** 客户端 ping 帧间隔（ms），默认 30000 */
  heartbeatIntervalMs: z.number().int().positive().default(30000),
  /** 断线重连间隔（ms），默认 5000 */
  reconnectIntervalMs: z.number().int().positive().default(5000),
  /** WS 连接握手超时（ms），默认 10000 */
  connectTimeoutMs: z.number().int().positive().default(10000),
});

export const OneBotHttpConfigSchema = z.object({
  /** OneBot HTTP API 地址，如 http://127.0.0.1:5700 */
  baseUrl: z.string().url(),
  /** 鉴权 token */
  accessToken: z.string().optional(),
  /** 单次请求超时（ms），默认 5000 */
  timeoutMs: z.number().int().positive().default(5000),
});

export const BotEntrySchema = z
  .object({
    /** 机器人唯一标识 */
    botId: z.string().min(1),
    /** 是否启用此 bot 的连接（false 时不会创建 adapter）。省略时默认 true。 */
    enabled: z.boolean().default(true),
    /** 传输模式 */
    mode: z.enum(["ws", "http", "hybrid"]),
    /** WS 配置（mode 为 ws 或 hybrid 时必填） */
    ws: OneBotWsConfigSchema.optional(),
    /** HTTP 配置（mode 为 http 或 hybrid 时必填） */
    http: OneBotHttpConfigSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.mode === "ws" || val.mode === "hybrid") && !val.ws) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `bot "${val.botId}": mode="${val.mode}" 时 ws 配置必填`,
        path: ["ws"],
      });
    }
    if ((val.mode === "http" || val.mode === "hybrid") && !val.http) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `bot "${val.botId}": mode="${val.mode}" 时 http 配置必填`,
        path: ["http"],
      });
    }
  });

/** bot.yaml 顶层是单个 bot 配置 */
export const BotConfigSchema = z.object({
  bot: BotEntrySchema,
});

export type BotWsConfig = z.infer<typeof OneBotWsConfigSchema>;
export type BotHttpConfig = z.infer<typeof OneBotHttpConfigSchema>;
export type BotEntry = z.infer<typeof BotEntrySchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;

// ---------------------------------------------------------------------------
// templates.yaml
// ---------------------------------------------------------------------------

export const TemplatesSchema = z.object({
  /** 消息模板，key 为模板名，value 为模板字符串 */
  templates: z.record(z.string(), z.string()).default({}),
});

export type TemplatesConfig = z.infer<typeof TemplatesSchema>;

// ---------------------------------------------------------------------------
// 聚合类型：全量配置
// ---------------------------------------------------------------------------

export interface AllConfig {
  settings: Settings;
  bot: BotConfig;
  templates: TemplatesConfig;
}
