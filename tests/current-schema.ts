/// <reference types="vite/client" />
import { statements } from "./statements";

const migrations = import.meta.glob<string>("../migrations/*.sql", { eager: true, query: "?raw", import: "default" });
export async function applyCurrentSchema(database: D1Database): Promise<void> {
  for (const [, sql] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
    for (const statement of statements(sql)) await database.prepare(statement).run();
  }
}
