import { connectDatabase, type DatabaseOptions, type DatabaseContext } from './connection.js';
import { assertDatabaseCurrent } from './migrations.js';

/** Business clients only validate the schema. Maintenance remains a server deployment operation. */
export async function openApplicationDatabase(options: DatabaseOptions): Promise<DatabaseContext> {
  const database = await connectDatabase(options);
  try {
    await assertDatabaseCurrent(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
