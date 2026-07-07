import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { LogEntry, LogQueryParams, LogRepository } from "./types.js";

// ---------------------------------------------------------------------------
// SQLite 日志仓库
// ---------------------------------------------------------------------------

export class SqliteLogRepository implements LogRepository {
  private db: Database.Database;

  constructor(dbPath: string) {
    const absPath = resolve(dbPath);
    // 确保父目录存在
    mkdirSync(dirname(absPath), { recursive: true });

    this.db = new Database(absPath);
    this.db.pragma("journal_mode = WAL");
    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id     TEXT    NOT NULL,
        level      TEXT    NOT NULL,
        message    TEXT    NOT NULL,
        meta       TEXT,
        created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_logs_bot_id    ON logs(bot_id);
      CREATE INDEX IF NOT EXISTS idx_logs_level     ON logs(level);
      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
    `);
  }

  async write(entry: LogEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO logs (bot_id, level, message, meta)
      VALUES (@botId, @level, @message, @meta)
    `);
    stmt.run({
      botId: entry.botId,
      level: entry.level,
      message: entry.message,
      meta: entry.meta ? JSON.stringify(entry.meta) : null,
    });
  }

  async query(params: LogQueryParams): Promise<LogEntry[]> {
    const conditions: string[] = [];
    const bindings: Record<string, unknown> = {};

    if (params.botId) {
      conditions.push("bot_id = @botId");
      bindings.botId = params.botId;
    }
    if (params.level) {
      conditions.push("level = @level");
      bindings.level = params.level;
    }
    if (params.from) {
      conditions.push("created_at >= @from");
      bindings.from = params.from.toISOString();
    }
    if (params.to) {
      conditions.push("created_at <= @to");
      bindings.to = params.to.toISOString();
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT id, bot_id, level, message, meta, created_at
         FROM logs ${where}
         ORDER BY created_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...bindings, limit, offset }) as Array<{
      id: number;
      bot_id: string;
      level: LogEntry["level"];
      message: string;
      meta: string | null;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      botId: r.bot_id,
      level: r.level,
      message: r.message,
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : undefined,
      createdAt: new Date(r.created_at),
    }));
  }

  async cleanup(retentionDays: number): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM logs WHERE created_at < datetime('now', 'localtime', @offset)`,
      )
      .run({ offset: `-${retentionDays} days` });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
