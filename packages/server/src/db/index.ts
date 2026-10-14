import { config } from '../config.js';
import { connectDatabase, type DatabaseContext } from './connection.js';
import { assertDatabaseCurrent } from './migrations.js';

let databasePromise: Promise<DatabaseContext> | undefined;

export function getDatabase(): Promise<DatabaseContext> {
  if (!databasePromise) {
    const pending = createDatabase();
    databasePromise = pending;
    void pending.catch(() => {
      if (databasePromise === pending) databasePromise = undefined;
    });
  }
  return databasePromise;
}

async function createDatabase(): Promise<DatabaseContext> {
  const database = await connectDatabase(config);
  try {
    await assertDatabaseCurrent(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  const pending = databasePromise;
  databasePromise = undefined;
  if (!pending) return;
  const database = await pending;
  await database.close();
}
