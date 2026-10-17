import path from 'node:path';
import { configurationSettings, type ConfigurationOptions } from './configurationSettings.js';
import type { DatabaseOptions } from './db/connection.js';
import type { RootOptions } from './users.js';

export function readAdminConfig(
  options: ConfigurationOptions & Partial<DatabaseOptions> = {},
): DatabaseOptions & RootOptions {
  const { env, yamlValue, filePath } = configurationSettings(options);
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (
    !databaseUrl &&
    !options.databaseDir &&
    !env.DATABASE_DIR &&
    !env.DATA_DIR &&
    yamlValue('databaseDir', 'database.dir') === undefined &&
    yamlValue('dataDir', 'data.dir') === undefined
  )
    throw new Error(
      'Database mode requires DATABASE_URL, --database-dir, or an explicit database/data directory in the server configuration',
    );
  const dataDir = filePath('DATA_DIR', 'data', 'dataDir', 'data.dir');
  return {
    databaseUrl: databaseUrl || undefined,
    databaseDir: options.databaseDir
      ? path.resolve(options.cwd ?? process.cwd(), options.databaseDir)
      : filePath('DATABASE_DIR', path.join(dataDir, 'users.pglite'), 'databaseDir', 'database.dir'),
    rootUsername: env.ROOT_USERNAME?.trim() || undefined,
    rootPassword: env.ROOT_PASSWORD || undefined,
  };
}
