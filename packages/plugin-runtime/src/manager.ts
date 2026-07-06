import "reflect-metadata";
import { resolve, sep } from "node:path";
import type { BotEvent, SendActionFn } from "@myfinal/shared";
import type {
  PluginInstance,
  PluginPublicMeta,
  PluginStore,
} from "./decorators.js";
import { stringifyPattern } from "./utils/pattern.js";
import { generateHelpTextFromViews, type HelpPluginView } from "./help/HelpGenerator.js";
import { dispatchEvent } from "./dispatch/PluginDispatcher.js";
import { PluginRegistry } from "./registry/PluginRegistry.js";
import { CommandRegistry } from "./registry/CommandRegistry.js";
import { PluginLoader } from "./loader/PluginLoader.js";
import { HotReloadWatcher } from "./loader/HotReloadWatcher.js";
import { BotActionSender, type BotService, type ActionResult } from "./bot-action/BotActionSender.js";

// ---------------------------------------------------------------------------
// PluginManager（facade，对外 API 不变）
// ---------------------------------------------------------------------------

export class PluginManager {
  private readonly _registry = new PluginRegistry();
  private readonly _commands = new CommandRegistry();
  private readonly _loader = new PluginLoader();
  private readonly _watcher = new HotReloadWatcher();
  private readonly _botAction = new BotActionSender();
  private _maintenanceMode = false;
  private _installLock = false;
  private _pluginsDir: string | null = null;

  constructor() {
    this._loader.setRuntimeView({
      plugins: {
        list: () => this.listPluginsMeta(),
      },
      commands: {
        version: () => this._commands.version,
        snapshot: (options) => this._commands.snapshot(options),
        roots: (options) => this._commands.roots(options),
        get: (id, options) => this._commands.get(id, options),
        children: (id, options) => this._commands.children(id, options),
        breadcrumb: (id) => this._commands.breadcrumb(id),
        resolveHelpPath: (input, options) => this._commands.resolveHelpPath(input, options),
      },
    });
  }

  // ── 加载 ──────────────────────────────────────────────────────────────────

  /**
   * 扫描目录，动态 import 所有插件并注册。
   * 约定：每个 .js 文件或子目录（含 index.js）默认导出一个被 @Plugin 装饰的类。
   */
  async loadAll(pluginsDir: string): Promise<void> {
    this._pluginsDir = pluginsDir;
    const files = await this._loader.scanDir(pluginsDir);
    for (const file of files) {
      await this._loadFile(file);
    }
  }

  private async _loadFile(filePath: string): Promise<void> {
    const instance = await this._loader.loadFile(filePath);
    if (instance) {
      await this._registerInstance(instance);
    }
  }

  private async _registerInstance(instance: PluginInstance): Promise<void> {
    try {
      if (this._registry.has(instance.meta.name)) {
        await this.unload(instance.meta.name);
      }
      this._commands.registerPlugin(instance);
      this._registry.set(instance.meta.name, instance);
    } catch (err) {
      this._commands.unregisterPlugin(instance.meta.name);
      console.error(`[plugin-runtime] 插件 "${instance.meta.name}" 指令注册失败:`, err);
    }
  }

  // ── 安装锁 ────────────────────────────────────────────────────────────────

  setInstallLock(locked: boolean): void {
    this._installLock = locked;
  }

  get installLock(): boolean {
    return this._installLock;
  }

  /**
   * 注册插件加载完成后的回调。
   * 每次插件加载（首次或热重载）完成后都会调用，可在此统一处理框架级资源注册。
   * 应在 loadAll / loadFromPath 之前设置。
   */
  setOnPluginLoaded(fn: (plugin: PluginInstance) => void | Promise<void>): void {
    this._loader.setOnPluginLoaded(fn);
  }

  setBotService(botService: BotService): void {
    this._botAction.setBotService(botService);
  }

  async sendBotAction(action: string, params?: Record<string, unknown>): Promise<ActionResult> {
    return this._botAction.sendBotAction(action, params);
  }

  // ── 公开加载 / 按目录卸载 ──────────────────────────────────────────────────

  /** 加载指定路径的插件文件（供安装路由显式调用）。 */
  async loadFromPath(filePath: string): Promise<void> {
    await this._loadFile(filePath);
  }

  /** 卸载 filePath 位于指定目录下的所有已加载插件。返回被卸载的插件名列表。 */
  async unloadByDir(dir: string): Promise<string[]> {
    const normalizedDir = resolve(dir);
    const names: string[] = [];
    for (const [name, plugin] of this._registry.entries()) {
      const fp = resolve(plugin.filePath);
      if (fp.startsWith(normalizedDir + sep) || fp.startsWith(normalizedDir + "/")) {
        names.push(name);
      }
    }
    for (const name of names) {
      await this.unload(name);
    }
    return names;
  }

  // ── 卸载 / 热重载 ─────────────────────────────────────────────────────────

  async unload(name: string): Promise<void> {
    const plugin = this._registry.get(name);
    if (!plugin) return;
    // 调用插件实例的 onStop 生命周期钩子（如有），清理定时器等资源
    if (typeof (plugin.instance as Record<string, unknown>)["onStop"] === "function") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (plugin.instance as any).onStop();
      } catch (err) {
        console.error(`[plugin-runtime] 插件 "${name}" onStop 异常:`, err);
      }
    }
    this._commands.unregisterPlugin(name);
    this._registry.delete(name);
    console.info(`[plugin-runtime] 插件 "${name}" 已卸载`);
  }

  async reload(name: string): Promise<void> {
    const plugin = this._registry.get(name);
    if (!plugin) {
      console.warn(`[plugin-runtime] 找不到插件 "${name}"，无法 reload`);
      return;
    }
    const next = await this._loader.loadFile(plugin.filePath);
    if (!next) {
      console.warn(`[plugin-runtime] 插件 "${name}" reload 失败，已保留旧实例`);
      return;
    }
    await this.unload(name);
    await this._registerInstance(next);
  }

  // ── 文件监听热重载 ────────────────────────────────────────────────────────

  watch(): void {
    if (!this._pluginsDir) return;
    this._watcher.watch(this._pluginsDir, {
      isInstallLocked: () => this._installLock,
      onChange: (filePath) => {
        const existing = this._registry.findByFilePath(filePath);
        if (existing) {
          this.reload(existing.meta.name).catch(console.error);
        } else {
          this._loadFile(filePath).catch(console.error);
        }
      },
      onAdd: (filePath) => {
        this._loadFile(filePath).catch(console.error);
      },
      onUnlink: (filePath) => {
        const existing = this._registry.findByFilePath(filePath);
        if (existing) {
          this.unload(existing.meta.name).catch(console.error);
        }
      },
    });
  }

  async unwatch(): Promise<void> {
    await this._watcher.unwatch();
  }

  // ── 事件分发 ──────────────────────────────────────────────────────────────

  /**
   * @deprecated Help 展示应由 Dian-plugin-help 通过 ctx.dian 只读视图实现。
   * 该方法仅保留给旧调用方做过渡，不再参与消息分发。
   */
  generateHelpText(): string {
    return generateHelpTextFromViews(this._getHelpPluginViews());
  }

  /**
   * 将事件分发给所有匹配的 handler。
   * 先按 priority 执行 interceptors，任意 interceptor 可调用 stopPropagation() 终止。
   * 再按注册顺序执行匹配 pattern 的 handlers。
   */
  async dispatch(
    event: BotEvent,
    reply: (text: string) => Promise<void> = async () => {},
    sendAction: SendActionFn = async () => ({ ok: false, status: "failed", message: "sendAction not implemented" }),
    store?: PluginStore | ((pluginName: string) => PluginStore | undefined),
  ): Promise<void> {
    if (this._maintenanceMode) return;
    await dispatchEvent(
      this._registry.all(),
      this._registry.blacklist as Set<string>,
      () => true, // 单 bot 模式下所有插件都启用
      (pluginId) => this._commands.getByPlugin(pluginId, { includeHidden: true }),
      event,
      reply,
      sendAction,
      store,
    );
  }

  // ── 黑名单 & 维护模式 ─────────────────────────────────────────────────────

  addToBlacklist(name: string): void {
    this._registry.addToBlacklist(name);
  }

  removeFromBlacklist(name: string): void {
    this._registry.removeFromBlacklist(name);
  }

  setMaintenanceMode(enabled: boolean): void {
    this._maintenanceMode = enabled;
  }

  // ── 只读信息 ──────────────────────────────────────────────────────────────

  get pluginsDir(): string | null {
    return this._pluginsDir;
  }

  get plugins(): PluginInstance[] {
    return this._registry.all();
  }

  get commands(): CommandRegistry {
    return this._commands;
  }

  get maintenanceMode(): boolean {
    return this._maintenanceMode;
  }

  /**
   * 返回所有插件的公开元信息（不包含 handler 实现）。
   * 主要供前端 API 使用。
   */
  listPluginsMeta(): PluginPublicMeta[] {
    return this._registry.all().map((p) => ({
      name: p.meta.name,
      description: p.meta.description,
      version: p.meta.version,
      author: p.meta.author,
      icon: p.meta.icon,
      enabled: !this._registry.isBlacklisted(p.meta.name),
      handlerCount: p.handlers.length,
      commandCount: this._commands.countByPlugin(p.meta.name),
      handlers: p.handlers.map((h) => ({
        method: h.method,
        pattern: stringifyPattern(h.pattern),
      })),
        commands: this._commands.getRootsByPlugin(p.meta.name).map((c) => ({
          name: c.name,
          pattern: c.pattern,
          description: c.description,
          usage: c.usage,
          examples: c.examples,
          category: c.category,
          children: c.children.map(commandNodeToPublicMeta),
      })),
      routes: p.routes.map((r) => ({ method: r.method, path: r.path, public: r.public === true })),
      hasUI: p.ui !== null,
      uiUrl: p.ui?.externalUrl
        ? p.ui.externalUrl
        : p.ui
          ? `/plugins/${encodeURIComponent(p.meta.name)}/ui/`
          : null,
    }));
  }

  private _getHelpPluginViews(): HelpPluginView[] {
    return this._registry
      .all()
      .filter((p) => !this._registry.isBlacklisted(p.meta.name))
      .map((p) => ({
        name: p.meta.name,
        description: p.meta.description,
        icon: p.meta.icon,
        commands: this._commands.getRootsByPlugin(p.meta.name),
        commandCount: this._commands.countByPlugin(p.meta.name),
      }));
  }
}

function commandNodeToPublicMeta(
  node: ReturnType<CommandRegistry["getRootsByPlugin"]>[number],
): PluginPublicMeta["commands"][number] {
  return {
    name: node.name,
    pattern: node.pattern,
    description: node.description,
    usage: node.usage,
    examples: node.examples,
    category: node.category,
    children: node.children.map(commandNodeToPublicMeta),
  };
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

export const pluginManager = new PluginManager();
