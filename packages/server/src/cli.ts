#!/usr/bin/env node
import { closeDatabase, getDatabase } from './db/index.js';
import { CREATABLE_ROLES, createUser, deleteUser, listUsers, updateUser } from './users.js';

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function flag(args: string[], name: string): boolean { return args.includes(name); }
function required(args: string[], name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`missing ${name}`);
  return result;
}
function usage(): string {
  return `Violet Map admin CLI

Usage:
  vm-admin users list
  vm-admin users create --username <name> --password <password> --role <viewer|ci|admin>
  vm-admin users update --username <name> [--password <password>] [--role <viewer|ci|admin>] [--enable|--disable]
  vm-admin users delete --username <name>

The CLI connects to DATABASE_URL when set; otherwise it uses DATA_DIR/users.pglite.
root and guest are virtual/reserved roles and cannot be created.`;
}

async function main(): Promise<void> {
  const [area, command, ...args] = process.argv.slice(2);
  if (!area || area === 'help' || area === '--help' || area === '-h') return void console.log(usage());
  if (area !== 'users' || !command) throw new Error(usage());
  await getDatabase();
  switch (command) {
    case 'list':
      console.table((await listUsers()).map((user) => ({ username: user.username, role: user.role, enabled: user.enabled, virtual: !!user.virtual, createdAt: user.createdAt ?? '' })));
      return;
    case 'create': {
      const role = required(args, '--role');
      if (!CREATABLE_ROLES.includes(role as typeof CREATABLE_ROLES[number])) throw new Error(`--role must be one of: ${CREATABLE_ROLES.join(', ')}`);
      const user = await createUser({ username: required(args, '--username'), password: required(args, '--password'), role: role as typeof CREATABLE_ROLES[number] });
      console.log(`created ${user.username} (${user.role})`);
      return;
    }
    case 'update': {
      const role = value(args, '--role');
      if (role && !CREATABLE_ROLES.includes(role as typeof CREATABLE_ROLES[number])) throw new Error(`--role must be one of: ${CREATABLE_ROLES.join(', ')}`);
      if (flag(args, '--enable') && flag(args, '--disable')) throw new Error('use either --enable or --disable, not both');
      const user = await updateUser(required(args, '--username'), {
        password: value(args, '--password'), role: role as typeof CREATABLE_ROLES[number] | undefined,
        enabled: flag(args, '--enable') ? true : flag(args, '--disable') ? false : undefined,
      });
      console.log(`updated ${user.username} (${user.role}, ${user.enabled ? 'enabled' : 'disabled'})`);
      return;
    }
    case 'delete':
      await deleteUser(required(args, '--username'));
      console.log(`deleted ${required(args, '--username')}`);
      return;
    default:
      throw new Error(usage());
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => closeDatabase());
