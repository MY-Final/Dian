import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdentifier(name: string, label: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid ${label}: "${name}". Only alphanumeric characters and underscores are allowed.`);
  }
}

/**
 * SQLite 插件存储实现
 * 为每个插件创建独立的表，表名由插件自行定义（建议格式：插件名_功能名）
 */
export class SqlitePluginStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const absPath = resolve(dbPath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.db = new Database(absPath);
    this.db.pragma("journal_mode = WAL");
    this._initMetaTable();
  }

  /**
   * 初始化元数据表，用于跟踪插件和表的关联关系
   */
  private _initMetaTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS _plugin_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_name TEXT NOT NULL,
      table_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
    )`);
    // 为 plugin_name 创建索引，加速查询
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_plugin_tables_plugin_name ON _plugin_tables(plugin_name)`);
  }

  /**
   * 创建插件专属表
   * @param tableName 完整表名
   * @param columns 列定义
   * @param pluginName 插件名称（用于元数据跟踪）
   */
  async createTable(tableName: string, columns: string[], pluginName?: string): Promise<void> {
    validateIdentifier(tableName, "table name");
    for (const col of columns) {
      const colName = col.trim().split(/\s+/)[0];
      validateIdentifier(colName, "column name");
    }
    const columnsDef = columns.join(", ");
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${columnsDef},
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
    )`);

    // 记录插件和表的关联关系
    if (pluginName) {
      this._trackTable(pluginName, tableName);
    }
  }

  /**
   * 记录插件创建的表
   */
  private _trackTable(pluginName: string, tableName: string): void {
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO _plugin_tables (plugin_name, table_name) VALUES (?, ?)`
      ).run(pluginName, tableName);
    } catch {
      // 忽略重复插入错误
    }
  }

  /**
   * 获取某个插件创建的所有表名
   */
  async getPluginTables(pluginName: string): Promise<string[]> {
    const rows = this.db.prepare(
      `SELECT table_name FROM _plugin_tables WHERE plugin_name = ?`
    ).all(pluginName) as { table_name: string }[];
    return rows.map(r => r.table_name);
  }

  /**
   * 删除某个插件创建的所有表
   */
  async dropPluginTables(pluginName: string): Promise<void> {
    const tables = await this.getPluginTables(pluginName);
    for (const table of tables) {
      validateIdentifier(table, "table name");
      this.db.exec(`DROP TABLE IF EXISTS "${table}"`);
    }
    // 清理元数据
    this.db.prepare(`DELETE FROM _plugin_tables WHERE plugin_name = ?`).run(pluginName);
  }

  /**
   * 插入数据
   */
  async insert(tableName: string, data: Record<string, unknown>): Promise<void> {
    validateIdentifier(tableName, "table name");
    const keys = Object.keys(data);
    for (const key of keys) {
      validateIdentifier(key, "column name");
    }
    const placeholders = keys.map(() => "?").join(", ");
    const values = Object.values(data);
    
    this.db.prepare(
      `INSERT INTO "${tableName}" (${keys.map(k => `"${k}"`).join(", ")}) VALUES (${placeholders})`
    ).run(...values);
  }

  /**
   * 查询数据
   */
  async query(tableName: string, params?: Record<string, unknown>, options?: {
    limit?: number;
    orderBy?: string;
    order?: "ASC" | "DESC";
  }): Promise<Record<string, unknown>[]> {
    validateIdentifier(tableName, "table name");
    let sql = `SELECT * FROM "${tableName}"`;
    const bindings: unknown[] = [];
    
    if (params && Object.keys(params).length > 0) {
      const conditions = Object.entries(params).map(([key, value]) => {
        validateIdentifier(key, "column name");
        if (value === null) return `"${key}" IS NULL`;
        bindings.push(value);
        return `"${key}" = ?`;
      });
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    
    if (options?.orderBy) {
      validateIdentifier(options.orderBy, "order by column");
      const order = options.order === "ASC" ? "ASC" : "DESC";
      sql += ` ORDER BY "${options.orderBy}" ${order}`;
    }
    
    if (options?.limit) {
      sql += ` LIMIT ${Number(options.limit)}`;
    }
    
    return this.db.prepare(sql).all(...bindings) as Record<string, unknown>[];
  }

  /**
   * 删除数据
   */
  async delete(tableName: string, params?: Record<string, unknown>): Promise<number> {
    validateIdentifier(tableName, "table name");
    let sql = `DELETE FROM "${tableName}"`;
    const bindings: unknown[] = [];
    
    if (params && Object.keys(params).length > 0) {
      const conditions = Object.entries(params).map(([key, value]) => {
        validateIdentifier(key, "column name");
        if (value === null) return `"${key}" IS NULL`;
        bindings.push(value);
        return `"${key}" = ?`;
      });
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    
    const result = this.db.prepare(sql).run(...bindings);
    return result.changes;
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    this.db.close();
  }
}
