import { openApplicationDatabase } from './db/application.js';
import type { DatabaseOptions } from './db/connection.js';
import { createUserService, type RootOptions } from './users.js';

export { readAdminConfig } from './configuration.js';
export type { ConfigurationOptions } from './configuration.js';
export type { DatabaseOptions } from './db/connection.js';
export type { RootOptions } from './users.js';

/** A trusted database operator. Importing this module never starts HTTP or opens a database. */
export async function createAdminContext(options: DatabaseOptions & RootOptions) {
  if (!options.databaseUrl && !options.databaseDir) throw new Error('An explicit database target is required');
  const database = await openApplicationDatabase(options);
  const service = createUserService(async () => database, options);
  return {
    users: {
      list: service.listUsers,
      create: service.createUser,
      update: service.updateUser,
      delete: service.deleteUser,
    },
    credentials: { issue: service.issueOperatorCredential, revoke: service.revokeUserCredentials },
    close: () => database.close(),
  };
}
