import { readAdminConfig } from '../adminConfiguration.js';
import { connectDatabase, withMigrationLock } from './connection.js';
import { baselineDatabase, databaseStatus, migrateDatabase } from './migrations.js';

async function main(): Promise<number> {
  const command = process.argv[2];
  if (process.argv.length !== 3 || !['status', 'migrate', 'baseline'].includes(command)) {
    throw new Error('Usage: node dist/src/db/maintenance.js <status|migrate|baseline>');
  }
  const database = await connectDatabase(readAdminConfig());
  try {
    const status =
      command === 'migrate'
        ? await migrateDatabase(database)
        : command === 'baseline'
          ? await baselineDatabase(database)
          : await withMigrationLock(database, (locked) => databaseStatus(locked));
    console.log(JSON.stringify({ driver: database.driver, ...status }, null, 2));
    return status.state === 'invalid' || status.state === 'legacy' ? 1 : 0;
  } finally {
    await database.close();
  }
}

// Finish/roll back the active operation and close PGlite before exiting on a
// normal deployment signal. SIGKILL/crashes deliberately require lock recovery.
let interruptedExitCode: number | undefined;

function interrupt(signal: NodeJS.Signals): void {
  interruptedExitCode = signal === 'SIGINT' ? 130 : 143;
  console.error(`[violet-map db] ${signal}: waiting for database maintenance to close safely`);
}

const sigint = () => interrupt('SIGINT');

const sigterm = () => interrupt('SIGTERM');

process.on('SIGINT', sigint);

process.on('SIGTERM', sigterm);

try {
  const exitCode = await main();
  // PGlite.close() resets process.exitCode; publish our result after cleanup.
  process.exitCode = interruptedExitCode ?? exitCode;
} catch (error) {
  console.error(`[violet-map db] ${(error as Error).message}`);
  process.exitCode = interruptedExitCode ?? 1;
} finally {
  process.off('SIGINT', sigint);
  process.off('SIGTERM', sigterm);
}
