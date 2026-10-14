import { config } from '../config.js';
import type { DatabaseContext } from './connection.js';
import { openApplicationDatabase } from './application.js';

let databasePromise: Promise<DatabaseContext> | undefined;

export function getDatabase(): Promise<DatabaseContext> {
  if (!databasePromise) {
    const pending = openApplicationDatabase(config);
    databasePromise = pending;
    void pending.catch(() => {
      if (databasePromise === pending) databasePromise = undefined;
    });
  }
  return databasePromise;
}

export async function closeDatabase(): Promise<void> {
  const pending = databasePromise;
  databasePromise = undefined;
  if (!pending) return;
  const database = await pending;
  await database.close();
}
