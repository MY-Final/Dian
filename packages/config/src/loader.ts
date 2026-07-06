import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import yaml from "js-yaml";
import type { ZodSchema } from "zod";
import {
  BotConfigSchema,
  SettingsSchema,
  TemplatesSchema,
  type AllConfig,
  type BotConfig,
  type Settings,
  type TemplatesConfig,
} from "./schema.js";

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Settings = {
  logLevel: "info",
  storage: {
    sqlite: "data/dian.db",
  },
  auth: {
    passwordHash: "$2b$10$swI7YQr18cCg1AzA6v5SleT.J5xfdp.LbvXp0IpmbCPxT7OPquDZO",
    tokenExpiresIn: 86400,
  },
};

const DEFAULT_BOT: BotConfig = {
  bot: {
    botId: "my-bot",
    enabled: false,
    mode: "hybrid",
    ws: {
      url: "ws://127.0.0.1:6700/",
      accessToken: "",
      heartbeatIntervalMs: 30000,
      reconnectIntervalMs: 5000,
      connectTimeoutMs: 10000,
    },
    http: {
      baseUrl: "http://127.0.0.1:5700/",
      accessToken: "",
      timeoutMs: 5000,
    },
  },
};

const DEFAULT_TEMPLATES: TemplatesConfig = {
  templates: {
    welcome: "欢迎 {name} 加入群聊！",
    goodbye: "再见，{name}，期待你的归来。",
  },
};

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 确保目录存在
 */
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 如果文件不存在，创建默认配置文件
 */
function ensureConfigFile(filePath: string, defaultContent: object): void {
  if (!existsSync(filePath)) {
    ensureDir(filePath);
    const content = yaml.dump(defaultContent, { lineWidth: -1 });
    writeFileSync(filePath, content, "utf-8");
    console.log(`[config] 已创建默认配置文件: ${filePath}`);
  }
}

/**
 * 读取 YAML 文件并用给定 Zod schema 解析，校验失败时抛出详细错误。
 */
function loadYaml<T>(filePath: string, schema: ZodSchema<T>): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `[config] 无法读取配置文件 "${filePath}": ${(err as NodeJS.ErrnoException).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `[config] YAML 解析失败 "${filePath}": ${(err as Error).message}`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => `  - ${(e.path as PropertyKey[]).map(String).join(".")}: ${e.message as string}`)
      .join("\n");
    throw new Error(
      `[config] 配置校验失败 "${filePath}":\n${details}`,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

export interface LoaderOptions {
  /** 配置目录路径，默认为 `<cwd>/config` */
  configDir?: string;
}

/**
 * 从磁盘加载全量配置（settings + bots + templates）。
 * 任意一项校验失败都会抛出错误，应在启动阶段调用以阻断进程。
 * 如果配置文件不存在，会自动创建默认配置文件。
 */
export function loadAllConfig(options: LoaderOptions = {}): AllConfig {
  const dir = resolve(options.configDir ?? "config");

  // 确保配置文件存在，不存在则创建默认配置
  ensureConfigFile(resolve(dir, "settings.yaml"), DEFAULT_SETTINGS);
  ensureConfigFile(resolve(dir, "bot.yaml"), DEFAULT_BOT);
  ensureConfigFile(resolve(dir, "templates.yaml"), DEFAULT_TEMPLATES);

  const settings: Settings = loadYaml(
    resolve(dir, "settings.yaml"),
    SettingsSchema,
  );

  const bot: BotConfig = loadYaml(
    resolve(dir, "bot.yaml"),
    BotConfigSchema,
  );

  const templates: TemplatesConfig = loadYaml(
    resolve(dir, "templates.yaml"),
    TemplatesSchema,
  );

  return { settings, bot, templates };
}
