import { existsSync, createReadStream, statSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { unzip } from "fflate";
import { pluginManager } from "@myfinal/plugin-runtime";
import type { LogService } from "@myfinal/logger";
import type { SqlitePluginStore } from "@myfinal/storage";
import { proxyFetch } from "../utils/proxy-fetch.js";

const MAX_ZIP_FILES = 500;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_PATH_DEPTH = 20;

// 静态资源 MIME 类型表（够用即可，无需引入 mime 库）
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
};

interface PluginRoutesOptions {
  logger: LogService;
  pluginsDir: string;
  persistPluginScope: () => Promise<void>;
  botService: import("../bot/bot-service.js").BotService;
  pluginStore?: SqlitePluginStore;
}

export async function pluginRoutes(
  app: FastifyInstance,
  opts: PluginRoutesOptions
): Promise<void> {
  const { logger, pluginsDir, persistPluginScope, botService, pluginStore } = opts;

  // ── GET /plugins ──────────────────────────────────────────────────────────
  app.get("/plugins", async (_req, reply) => {
    return reply.send({ plugins: pluginManager.listPluginsMeta() });
  });

  // ── PUT /plugins/:name/enabled ─────────────────────────────────────────────
  app.put<{
    Params: { name: string };
    Body: { enabled: boolean };
  }>("/plugins/:name/enabled", async (req, reply) => {
    const { name } = req.params;
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be boolean" });
    }
    if (enabled) {
      pluginManager.removeFromBlacklist(name);
    } else {
      pluginManager.addToBlacklist(name);
    }
    logger.info(`Plugin ${name} ${enabled ? "enabled" : "disabled"}`);
    return reply.send({ ok: true });
  });

  // ── GET /plugins/:name/tables ─────────────────────────────────────────────
  // 获取插件创建的表列表
  app.get<{ Params: { name: string } }>("/plugins/:name/tables", async (req, reply) => {
    const { name } = req.params;
    if (!name || !/^[\w-]+$/.test(name)) {
      return reply.code(400).send({ error: "invalid plugin name" });
    }

    if (!pluginStore) {
      return reply.send({ tables: [] });
    }

    try {
      const tables = await pluginStore.getPluginTables(name);
      return reply.send({ tables });
    } catch (err) {
      logger.error(`Failed to get plugin tables: ${name}`, { err: (err as Error).message });
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── DELETE /plugins/:name ──────────────────────────────────────────────────
  app.delete<{ Params: { name: string }; Querystring: { deleteData?: string } }>(
    "/plugins/:name",
    async (req, reply) => {
      const { name } = req.params;
      const deleteData = req.query.deleteData === "true";

      if (!name || !/^[\w-]+$/.test(name)) {
        return reply.code(400).send({ error: "invalid plugin name" });
      }

      // 必须在 unload 之前先拿到 filePath，
      // 否则 plugins.find 会返回 undefined；且 meta.name 与目录名常不一致。
      const loadedPlugin = pluginManager.plugins.find((p) => p.meta.name === name);
      const loadedFilePath = loadedPlugin?.filePath;

      // 从内存卸载
      await pluginManager.unload(name);
      // 同步清掉黑名单状态，避免重装后仍处于禁用
      pluginManager.removeFromBlacklist(name);

      // 删除插件数据（如果用户选择）
      if (deleteData && pluginStore) {
        try {
          await pluginStore.dropPluginTables(name);
          logger.info(`Plugin "${name}" data tables dropped`);
        } catch (err) {
          logger.error(`Failed to drop plugin data tables: ${name}`, { err: (err as Error).message });
        }
      }

      // 计算真实目标：优先用已加载插件的实际路径
      const targetDir  = loadedFilePath ? dirname(loadedFilePath) : join(pluginsDir, name);
      const targetFile = loadedFilePath && loadedFilePath.endsWith(".js")
        ? loadedFilePath
        : join(pluginsDir, `${name}.js`);

      try {
        let removed = false;
        // 单文件插件（plugins/foo.js）：父目录就是 pluginsDir，只删文件
        if (targetDir === resolve(pluginsDir)) {
          if (existsSync(targetFile)) {
            await unlink(targetFile);
            removed = true;
          }
        } else if (existsSync(targetDir)) {
          await rm(targetDir, { recursive: true, force: true });
          removed = true;
        } else if (existsSync(targetFile)) {
          await unlink(targetFile);
          removed = true;
        }

        if (!removed) {
          logger.warn(`Plugin "${name}" unloaded from memory, but no files were found to delete (targetDir=${targetDir})`);
          return reply.code(404).send({
            error: `plugin "${name}" not found on disk`,
            hint: "插件已从内存卸载，但磁盘上未找到对应目录或文件",
          });
        }

        logger.info(`Plugin uninstalled: ${name}`);
        return reply.send({ ok: true });
      } catch (err) {
        logger.error(`Failed to uninstall plugin: ${name}`, { err: (err as Error).message });
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── POST /plugins/upload ─────────────────────────────────────────────────
  app.post<{
    Querystring: { name?: string; force?: string };
    Body: Buffer;
  }>("/plugins/upload", async (req, reply) => {
    const rawName = req.query.name ?? "";
    const name = rawName.trim().replace(/\.zip$/i, "");
    const force = req.query.force === "true";

    if (!name || !/^[\w-]+$/.test(name)) {
      return reply.code(400).send({ error: "missing or invalid ?name= (alphanumeric / dash / underscore only)" });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "empty body" });
    }

    const destDir = join(pluginsDir, name);
    const alreadyExists = existsSync(destDir) || existsSync(join(pluginsDir, `${name}.js`));

    // 如果已存在且未传 force，返回 409 让前端确认
    if (alreadyExists && !force) {
      const loaded = pluginManager.plugins.find(
        (p) => p.meta.name === name || resolve(p.filePath).startsWith(resolve(destDir) + sep) || resolve(p.filePath).startsWith(resolve(destDir) + "/")
      );
      return reply.code(409).send({
        exists: true,
        name,
        currentVersion: loaded?.meta.version ?? null,
        hint: "插件已存在，传 ?force=true 覆盖安装",
      });
    }

    try {
      pluginManager.setInstallLock(true);

      // 覆盖安装：卸载旧插件 + 清理旧文件
      if (alreadyExists) {
        await pluginManager.unloadByDir(destDir);
        // 也按名称卸载（目录名和 meta.name 可能不同）
        await pluginManager.unload(name);
        if (existsSync(destDir)) {
          await rm(destDir, { recursive: true, force: true });
        }
        const singleFile = join(pluginsDir, `${name}.js`);
        if (existsSync(singleFile)) {
          await unlink(singleFile);
        }
      }

      await mkdir(destDir, { recursive: true });

      // 使用 fflate 解压 ZIP（纯 JS，跨平台无需 PowerShell）
      await extractPluginZip(new Uint8Array(body), destDir);

      // 自动加载新插件到内存
      const indexFile = join(destDir, "index.js");
      if (existsSync(indexFile)) {
        await pluginManager.loadFromPath(indexFile);
      }

      pluginManager.setInstallLock(false);

      logger.info(`Plugin ${alreadyExists ? "updated" : "installed"}: ${name} -> ${destDir}`);
      return reply.send({ ok: true, name, destDir, replaced: alreadyExists });
    } catch (err) {
      pluginManager.setInstallLock(false);
      logger.error(`Plugin install failed: ${name}`, { err: (err as Error).message });
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /plugins/install-from-url ──────────────────────────────────────
  // 服务端下载 ZIP 并安装，避免浏览器直接请求 GitHub Release 时的 CORS / 重定向问题
  app.post<{
    Body: { url?: unknown; force?: unknown };
  }>("/plugins/install-from-url", async (req, reply) => {
    const { url, force: rawForce } = (req.body ?? {}) as { url?: unknown; force?: unknown };
    const force = rawForce === true || rawForce === "true";
    if (typeof url !== "string" || !url.startsWith("http")) {
      return reply.code(400).send({ error: "url must be a valid http/https string" });
    }

    // 从 URL 中提取插件名（取最后一段路径，去掉 .zip）
    const urlName = url.split("/").pop()?.replace(/\.zip$/i, "").trim() ?? "";
    if (!urlName || !/^[\w-]+$/.test(urlName)) {
      return reply.code(400).send({ error: "cannot infer plugin name from url" });
    }

    const destDir = join(pluginsDir, urlName);
    const alreadyExists = existsSync(destDir) || existsSync(join(pluginsDir, `${urlName}.js`));

    // 如果已存在且未传 force，返回 409 让前端确认
    if (alreadyExists && !force) {
      const loaded = pluginManager.plugins.find(
        (p) => p.meta.name === urlName || resolve(p.filePath).startsWith(resolve(destDir) + sep) || resolve(p.filePath).startsWith(resolve(destDir) + "/")
      );
      return reply.code(409).send({
        exists: true,
        name: urlName,
        currentVersion: loaded?.meta.version ?? null,
        hint: "插件已存在，传 force: true 覆盖安装",
      });
    }

    let zipData: Uint8Array;
    try {
      const res = await proxyFetch(url);
      if (!res.ok) {
        return reply.code(502).send({ error: `upstream responded ${res.status}: ${res.statusText}` });
      }
      zipData = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      logger.error(`Failed to download plugin from ${url}`, { err: (err as Error).message });
      return reply.code(502).send({ error: `download failed: ${(err as Error).message}` });
    }

    try {
      pluginManager.setInstallLock(true);

      // 覆盖安装：卸载旧插件 + 清理旧文件
      if (alreadyExists) {
        await pluginManager.unloadByDir(destDir);
        await pluginManager.unload(urlName);
        if (existsSync(destDir)) {
          await rm(destDir, { recursive: true, force: true });
        }
        const singleFile = join(pluginsDir, `${urlName}.js`);
        if (existsSync(singleFile)) {
          await unlink(singleFile);
        }
      }

      await mkdir(destDir, { recursive: true });

      await extractPluginZip(zipData, destDir);

      // 自动加载新插件到内存
      const indexFile = join(destDir, "index.js");
      if (existsSync(indexFile)) {
        await pluginManager.loadFromPath(indexFile);
      }

      pluginManager.setInstallLock(false);

      logger.info(`Plugin ${alreadyExists ? "updated" : "installed"} from url: ${urlName} -> ${destDir}`);
      return reply.send({ ok: true, name: urlName, destDir, replaced: alreadyExists });
    } catch (err) {
      pluginManager.setInstallLock(false);
      logger.error(`Plugin install-from-url failed: ${urlName}`, { err: (err as Error).message });
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── 插件 API（catch-all，热插拔无需重启） ────────────────────────────────
  // 关键设计：不再为每个 plugin/route 单独 app.route()（那样卸载/重载会撞重复注册），
  // 而是注册一个通配 handler，根据请求 URL 在内存中查找当前已加载插件 + 路由实例。
  // 支持路径参数 :param，匹配成功后会将参数注入 req.params。
  function matchPluginRoute(routePath: string, actualPath: string): Record<string, string> | null {
    const rp = routePath.split("/").filter(Boolean);
    const ap = actualPath.split("/").filter(Boolean);
    if (rp.length !== ap.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(":")) {
        params[rp[i].slice(1)] = ap[i];
      } else if (rp[i] !== ap[i]) {
        return null;
      }
    }
    return params;
  }

  const apiHandler = async (req: import("fastify").FastifyRequest, reply: FastifyReply) => {
    const { name, '*': rest } = req.params as { name: string; "*": string };
    const subPath = `/${rest ?? ""}`.replace(/\/+$/, "") || "/";

    const plugin = pluginManager.plugins.find((p) => p.meta.name === decodeURIComponent(name));
    if (!plugin) {
      return reply.code(404).send({ error: `plugin "${name}" not loaded` });
    }
    const route = plugin.routes.find((r) => {
      if (r.method !== req.method) return false;
      // 先尝试精确匹配（无参数路由）
      if (r.path === subPath || r.path === subPath + "/" || r.path + "/" === subPath) return true;
      // 再尝试参数化匹配
      const params = matchPluginRoute(r.path, subPath);
      if (params) {
        // 将解析出的参数注入 req.params，供 handler 使用
        for (const [k, v] of Object.entries(params)) {
          (req.params as Record<string, unknown>)[k] = v;
        }
        return true;
      }
      return false;
    });
    if (!route) {
      return reply.code(404).send({ error: `no ${req.method} ${subPath} on plugin "${plugin.meta.name}"` });
    }
    // 注入 botService，供插件路由 handler 调用底层 API
    ;(req as unknown as Record<string, unknown>).botService = botService;
    if (pluginStore) {
      const pluginName = plugin.meta.name;
      ;(req as unknown as Record<string, unknown>).pluginStore = {
        createTable: (tableName: string, columns: string[]) => pluginStore.createTable(tableName, columns, pluginName),
        insert: (tableName: string, data: Record<string, unknown>) => pluginStore.insert(tableName, data),
        query: (
          tableName: string,
          params?: Record<string, unknown>,
          options?: { limit?: number; orderBy?: string; order?: "ASC" | "DESC" },
        ) => pluginStore.query(tableName, params, options),
        delete: (tableName: string, params?: Record<string, unknown>) => pluginStore.delete(tableName, params),
      };
    }
    return route.handler(req, reply);
  };

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    app.route({ method, url: "/plugins/:name/api/*", handler: apiHandler });
    app.route({ method, url: "/plugins/:name/api",   handler: apiHandler });
  }

  // ── 插件静态 UI（/plugins/:name/ui/*，手动 serve，热插拔安全） ─────────────
  app.get<{ Params: { name: string; "*": string } }>(
    "/plugins/:name/ui/*",
    async (req, reply) => serveStatic(req.params.name, req.params["*"], reply, logger)
  );
  app.get<{ Params: { name: string } }>(
    "/plugins/:name/ui",
    async (req, reply) => reply.redirect(`/plugins/${encodeURIComponent(req.params.name)}/ui/`)
  );
  app.get<{ Params: { name: string } }>(
    "/plugins/:name/ui/",
    async (req, reply) => serveStatic(req.params.name, "", reply, logger)
  );

  // 已加载插件的状态/UI 注册情况打印（仅日志）
  for (const plugin of pluginManager.plugins) {
    logger.info(
      `Plugin ready: ${plugin.meta.name} (routes=${plugin.routes.length}, ui=${plugin.ui ? "yes" : "no"})`
    );
  }
}

async function extractPluginZip(zipData: Uint8Array, destDir: string): Promise<void> {
  await new Promise<void>((res, rej) => {
    unzip(zipData, async (err, files) => {
      if (err) { rej(err); return; }
      try {
        const entries = validateZipEntries(files, destDir);
        for (const { dest, data } of entries) {
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, data);
        }
        res();
      } catch (writeErr) {
        rej(writeErr);
      }
    });
  });
}

function validateZipEntries(files: Record<string, Uint8Array>, destDir: string): Array<{ dest: string; data: Uint8Array }> {
  const root = resolve(destDir);
  const normalizedRoot = normalizePathForCompare(root);
  const entries: Array<{ dest: string; data: Uint8Array }> = [];
  let totalBytes = 0;

  for (const [filePath, data] of Object.entries(files)) {
    if (filePath.endsWith("/")) continue;

    if (filePath.includes("\0") || filePath.includes("\\")) {
      throw new Error(`invalid zip entry path: ${filePath}`);
    }

    const parts = filePath.split("/").filter(Boolean);
    if (
      parts.length === 0 ||
      parts.length > MAX_ZIP_PATH_DEPTH ||
      parts.some((part) => part === "." || part === ".." || /^[a-zA-Z]:$/.test(part)) ||
      filePath.startsWith("/")
    ) {
      throw new Error(`invalid zip entry path: ${filePath}`);
    }

    totalBytes += data.byteLength;
    if (entries.length >= MAX_ZIP_FILES) {
      throw new Error(`zip contains too many files (max ${MAX_ZIP_FILES})`);
    }
    if (totalBytes > MAX_UNZIPPED_BYTES) {
      throw new Error(`zip uncompressed size exceeds ${MAX_UNZIPPED_BYTES} bytes`);
    }

    const dest = resolve(root, ...parts);
    const normalizedDest = normalizePathForCompare(dest);
    if (normalizedDest !== normalizedRoot && !normalizedDest.startsWith(`${normalizedRoot}/`)) {
      throw new Error(`zip entry escapes plugin directory: ${filePath}`);
    }

    entries.push({ dest, data });
  }

  return entries;
}

function normalizePathForCompare(path: string): string {
  const normalized = normalize(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 根据当前已加载插件元信息，从插件的 staticDir 中读取并返回文件。
 * - 路径规范化，拒绝目录穿越。
 * - 找不到文件或插件未声明 UI 时返回 404。
 */
async function serveStatic(
  rawName: string,
  rawSubPath: string,
  reply: FastifyReply,
  logger: LogService
): Promise<FastifyReply> {
  const name = decodeURIComponent(rawName);
  const plugin = pluginManager.plugins.find((p) => p.meta.name === name);
  if (!plugin || !plugin.ui?.staticDir) {
    return reply.code(404).send({ error: `plugin "${name}" has no UI` });
  }

  const pluginDir = dirname(plugin.filePath);
  const staticRoot = resolve(pluginDir, plugin.ui.staticDir);
  const indexFile = plugin.ui.entry ?? "index.html";

  // 解码 + 规范化子路径，去掉首尾斜杠，空则视为 index
  const sub = decodeURIComponent(rawSubPath ?? "").replace(/^\/+|\/+$/g, "");
  const target = sub === "" ? indexFile : sub;

  // 防目录穿越：解析后的路径必须仍在 staticRoot 下
  const filePath = normalize(resolve(staticRoot, target));
  if (!filePath.startsWith(staticRoot + sep) && filePath !== staticRoot) {
    return reply.code(403).send({ error: "forbidden" });
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return reply.code(404).send({ error: "not found" });
  }
  // 目录请求 → 回退到 index 文件
  let finalPath = filePath;
  if (stat.isDirectory()) {
    finalPath = resolve(filePath, indexFile);
    try {
      stat = statSync(finalPath);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  }

  const mime = MIME_TYPES[extname(finalPath).toLowerCase()] ?? "application/octet-stream";
  reply.header("Content-Type", mime);
  reply.header("Content-Length", stat.size);
  reply.header("Cache-Control", "no-cache");
  logger.debug?.(`[plugin-ui] ${name} -> ${finalPath}`);
  return reply.send(createReadStream(finalPath));
}
