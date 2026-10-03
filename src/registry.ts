// The list of repositories registered with dibs. One instance for the whole deployment.

import { DurableObject } from "cloudflare:workers";

export interface RegisteredRepo {
  name: string;
  createdAt: number;
}

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
    });
  }

  async add(name: string): Promise<{ created: boolean }> {
    const cursor = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO repos (name, created_at) VALUES (?, ?)",
      name,
      Date.now(),
    );
    return { created: cursor.rowsWritten > 0 };
  }

  async list(): Promise<RegisteredRepo[]> {
    return this.ctx.storage.sql
      .exec<{ name: string; created_at: number }>("SELECT name, created_at FROM repos ORDER BY created_at, name")
      .toArray()
      .map((row) => ({ name: row.name, createdAt: row.created_at }));
  }
}
