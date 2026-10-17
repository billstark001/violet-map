import type { DatabaseOptions, DatabaseContext } from './connection.js';
import { openApplicationDatabase } from './application.js';

export function createDatabaseService(options: DatabaseOptions) {
  let pending: Promise<DatabaseContext> | undefined;
  let closed = false;
  function getDatabase(): Promise<DatabaseContext> {
    if (closed) return Promise.reject(new Error('Database service is closed'));
    if (!pending) {
      const opening = openApplicationDatabase(options);
      pending = opening;
      void opening.catch(() => {
        if (pending === opening) pending = undefined;
      });
    }
    return pending;
  }
  let closing: Promise<void> | undefined;
  function closeDatabase(): Promise<void> {
    if (!closing) {
      closed = true;
      const opening = pending;
      pending = undefined;
      closing = (async () => {
        if (opening) {
          const database = await opening.catch(() => undefined);
          await database?.close();
        }
      })();
    }
    return closing;
  }
  return { getDatabase, closeDatabase };
}
