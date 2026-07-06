import "reflect-metadata";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_META_KEY,
  HANDLER_META_KEY,
  INTERCEPTOR_META_KEY,
  type CommandEntry,
  type HandlerMeta,
  type InterceptorMeta,
  type DianRuntimeView,
  type PluginInstance,
  type PluginMeta,
  type PluginSetupContext,
  type RouteEntry,
  type UIDeclaration,
} from "../decorators.js";

/**
 * 插件加载器：负责从文件系统加载插件并返回 PluginInstance。
 * 不维护任何状态，纯"文件 → 实例"转换。
 */
export class PluginLoader {
  private _onPluginLoaded: ((plugin: PluginInstance) => void | Promise<void>) | null = null;
  private _runtimeView: DianRuntimeView | null = null;

  /** 注册插件加载完成后的回调。 */
  setOnPluginLoaded(fn: (plugin: PluginInstance) => void | Promise<void>): void {
    this._onPluginLoaded = fn;
  }

  setRuntimeView(view: DianRuntimeView): void {
    this._runtimeView = view;
  }

  /**
   * 扫描目录，返回所有待加载的插件文件路径。
   * 约定：每个 .js 文件或子目录（含 index.js）。
   */
  async scanDir(pluginsDir: string): Promise<string[]> {
    const dir = resolve(pluginsDir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = resolve(dir, entry);
      const ext = extname(entry);
      if (ext === ".js") {
        files.push(fullPath);
      } else if (ext === "") {
        const indexFile = resolve(fullPath, "index.js");
        if (existsSync(indexFile)) {
          files.push(indexFile);
        }
      }
    }
    return files;
  }

  /**
   * 从单个文件加载插件，返回 PluginInstance 或 null（加载失败/格式不符）。
   * ESM cache busting: 加 ?t=<timestamp> 绕过 Node 模块缓存。
   */
  async loadFile(filePath: string): Promise<PluginInstance | null> {
    let imported: Record<string, unknown>;
    try {
      const url = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
      imported = (await import(url)) as Record<string, unknown>;
    } catch (err) {
      console.error(`[plugin-runtime] 加载插件失败 "${filePath}":`, err);
      return null;
    }

    const PluginClass = imported.default;
    if (typeof PluginClass !== "function") {
      console.warn(`[plugin-runtime] "${filePath}" 未默认导出类，已跳过`);
      return null;
    }

    const meta = Reflect.getMetadata(PLUGIN_META_KEY, PluginClass) as PluginMeta | undefined;
    if (!meta) {
      console.warn(`[plugin-runtime] "${filePath}" 未使用 @Plugin 装饰，已跳过`);
      return null;
    }

    const instance = new (PluginClass as new () => unknown)();
    const handlers: HandlerMeta[] =
      (Reflect.getMetadata(HANDLER_META_KEY, PluginClass) as HandlerMeta[] | undefined) ?? [];
    const interceptors: InterceptorMeta[] =
      (Reflect.getMetadata(INTERCEPTOR_META_KEY, PluginClass) as InterceptorMeta[] | undefined) ?? [];

    interceptors.sort((a, b) => a.priority - b.priority);

    // ── 收集 onSetup 注册的路由/指令/UI/数据源 ─────────────────────────────
    const routes: RouteEntry[] = [];
    const commands: CommandEntry[] = [];
    const datasources: { name: string; file: string }[] = [];
    let ui: UIDeclaration | null = null;

    if ((meta as PluginMeta & { ui?: UIDeclaration }).ui) {
      ui = (meta as PluginMeta & { ui?: UIDeclaration }).ui!;
    }

    if (typeof (instance as Record<string, unknown>)["onSetup"] === "function") {
      if (!this._runtimeView) {
        throw new Error("[plugin-runtime] PluginLoader runtime view is not configured");
      }
      const ctx: PluginSetupContext = {
        dian: this._runtimeView,
        route(method, path, handler, options) {
          routes.push({ method, path, handler, public: options?.public === true });
        },
        command(entry) {
          commands.push(entry);
        },
        ui(decl) {
          ui = decl;
        },
        datasource(name, file) {
          datasources.push({ name, file });
        },
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (instance as any).onSetup(ctx);
      } catch (err) {
        console.error(`[plugin-runtime] 插件 "${meta.name}" onSetup 异常:`, err);
      }
    }

    const pluginInstance: PluginInstance = {
      meta,
      handlers,
      interceptors,
      routes,
      commands,
      datasources,
      ui,
      instance,
      filePath,
    };

    console.info(`[plugin-runtime] 插件 "${meta.name}" 已加载`);

    if (this._onPluginLoaded) {
      try {
        await this._onPluginLoaded(pluginInstance);
      } catch (err) {
        console.error(`[plugin-runtime] onPluginLoaded hook for "${meta.name}" 异常:`, err);
      }
    }

    return pluginInstance;
  }
}
