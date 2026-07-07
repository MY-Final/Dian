import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { configService } from "@myfinal/config";
import { logService } from "@myfinal/logger";
import { pluginManager } from "@myfinal/plugin-runtime";
import { storageService, SqlitePluginStore } from "@myfinal/storage";
import { BotService } from "./bot/bot-service.js";
import { EventBus } from "./event/event-bus.js";
import { EventDispatcher } from "./event/event-dispatcher.js";
import { DatabaseExplorer } from "./db/explorer.js";
import { AuthService } from "./auth/service.js";
import { installLogPersistence } from "./log-bridge.js";
import { installMessagePersistence } from "./message-bridge.js";
import { createServer } from "./server/fastify.js";

// ---------------------------------------------------------------------------
// 根目录（项目根，config/ 在此目录下）
// ---------------------------------------------------------------------------
const ROOT_DIR = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const CONFIG_DIR = resolve(ROOT_DIR, "config");
const PLUGINS_DIR = resolve(ROOT_DIR, "plugins");

async function main(): Promise<void> {
  // ── 1. 加载配置 ──────────────────────────────────────────────────────────
  configService.init(CONFIG_DIR);

  // ── 2. 初始化日志 ─────────────────────────────────────────────────────────
  logService.init({
    level: configService.settings.logLevel,
    pretty: process.env.NODE_ENV !== "production",
  });
  const logger = logService;
  logger.info("Dian server starting...");

  // ── 2b. 初始化持久化存储 + 日志镜像写入 ───────────────────────────────────
  if (configService.settings.storage?.sqlite || configService.settings.storage?.mysql) {
    await storageService.init({
      sqlite: configService.settings.storage.sqlite
        ? resolve(ROOT_DIR, configService.settings.storage.sqlite)
        : undefined,
      mysql: configService.settings.storage.mysql,
    });
    if (storageService.hasLog) {
      installLogPersistence(logger, storageService.log);
      logger.info("Log persistence enabled");
    }
    if (storageService.hasMessage) {
      logger.info("Message persistence enabled");
    }
  }

  // ── 3. 准备插件运行依赖 ───────────────────────────────────────────────────
  // 数据库浏览器必须在插件加载前创建，以便框架在 onPluginLoaded hook 中统一注册数据源
  const dbExplorer = new DatabaseExplorer(logger);
  if (configService.settings.storage?.sqlite) {
    const sqliteFile = resolve(
      ROOT_DIR,
      configService.settings.storage.sqlite
    );
    dbExplorer.registerSqlite("default", sqliteFile);
  }
  // 框架统一注册：每当插件加载（含热重载）完成，将其声明的 datasources 注册到 DatabaseExplorer
  pluginManager.setOnPluginLoaded((plugin) => {
    for (const ds of plugin.datasources) {
      dbExplorer.registerSqlite(ds.name, ds.file);
      logger.info(`Plugin datasource registered: ${ds.name} -> ${ds.file}`);
    }
  });
  // ── 4a. 事件总线 + 分发器 & BotService ────────────────────────────────────
  const eventBus = new EventBus(200);
  const dispatcher = new EventDispatcher(logger);

  // 消息持久化回调（在事件进入 dispatcher 前先写 DB）
  const persistMessage = storageService.hasMessage
    ? installMessagePersistence(storageService.message)
    : null;

  // 注入消息仓库到 dispatcher，用于存储机器人发送的消息
  if (storageService.hasMessage) {
    dispatcher.setMessageRepository(storageService.message);
  }

  // 创建插件存储实例
  let pluginStore: SqlitePluginStore | undefined;
  if (configService.settings.storage?.sqlite) {
    const sqliteFile = resolve(ROOT_DIR, configService.settings.storage.sqlite);
    pluginStore = new SqlitePluginStore(sqliteFile);
    dispatcher.setStore(pluginStore);
    logger.info("Plugin store enabled (SQLite)");
  }

  const botService = new BotService(
    configService,
    logger,
    async (event) => {
      persistMessage?.(event);
      eventBus.publish(event);
      await dispatcher.dispatch(event);
    }
  );
  // 将 botService 注入 dispatcher，用于构建 reply 回调
  dispatcher.setBotService(botService);
  // 将 botService 注入 pluginManager，用于插件发送消息
  pluginManager.setBotService(botService);

  // ── 5. 初始化认证服务 ─────────────────────────────────────────────────────
  const settingsPath = resolve(CONFIG_DIR, "settings.yaml");
  const authService = new AuthService(configService.settings.auth ?? {}, {
    onGenerateJwtSecret: async (secret) => {
      // 将自动生成的 jwtSecret 写回 settings.yaml，避免重启后 token 全部失效
      try {
        let text = await readFile(settingsPath, "utf8");
        if (/^\s*#?\s*jwtSecret\s*:/m.test(text)) {
          // 替换已存在（含被注释）的 jwtSecret 行
          text = text.replace(
            /^\s*#?\s*jwtSecret\s*:.*/m,
            `  jwtSecret: "${secret}"`,
          );
        } else {
          // 在 auth: 块末尾追加
          text = text.replace(
            /(auth:\s*\n(?:\s+.*\n)*?)(?=\n\S|\s*$)/,
            `$1  jwtSecret: "${secret}"\n`,
          );
        }
        await writeFile(settingsPath, text, "utf8");
        logger.info("Generated jwtSecret persisted to settings.yaml");
      } catch (err) {
        logger.warn("Failed to persist jwtSecret, tokens will be invalidated on restart", { err });
      }
    },
  });
  if (authService.isConfigured()) {
    logger.info("Auth service enabled");
  } else {
    logger.warn("Auth service disabled: no password configured");
  }

  // ── 5. 启动 HTTP 服务器 ───────────────────────────────────────────────────
  const server = await createServer({
    port: Number(process.env.PORT ?? 3000),
    logger,
    botService,
    configDir: CONFIG_DIR,
    pluginsDir: PLUGINS_DIR,
    eventBus,
    dbExplorer,
    messageRepo: storageService.hasMessage ? storageService.message : undefined,
    pluginStore,
    persistPluginScope: async () => {}, // 占位，单 bot 模式无需持久化
    authService,
  });
  await server.start();

  // ── 6. 后台加载插件 ───────────────────────────────────────────────────────
  // 不阻塞 HTTP 启动；慢插件初始化失败或下载依赖时，控制台仍可访问。
  logger.info(`Loading plugins from ${PLUGINS_DIR}`);
  void pluginManager.loadAll(PLUGINS_DIR)
    .then(() => {
      pluginManager.watch(); // 监听新安装的插件文件，自动热加载
    })
    .catch((err) => {
      logger.error("Failed to load plugins", { err });
    });

  // ── 7. 启动 Bot ───────────────────────────────────────────────────────────
  await botService.start();

  // ── 8. 热重载配置变更 ────────────────────────────────────────────────────
  configService.watch();
  configService.on("change", async ({ file }) => {
    logger.info(`Config changed: ${file}, reloading bot...`);
    await botService.reloadConfig();
  });

  // ── 9. 优雅退出 ──────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    configService.unwatch();
    await botService.stop();
    await server.stop();
    dbExplorer.close();
    await storageService.close();
    logger.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
