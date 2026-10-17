import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { loadContext, type GlobalOptions } from './context.js';
import { cliPaths } from './settings/paths.js';
import { redact } from './settings/secrets.js';
import type { ManagementOptions } from './management.js';
import type { CreatableRole } from '@violet-map/core/contracts';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const roles = ['viewer', 'ci', 'admin'];
function integer(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new InvalidArgumentError('expected a positive safe integer');
  return number;
}
function globals(command: Command): Command {
  // Positional scopes keep the CLI --version separate from assets extract --version.
  return command
    .enablePositionalOptions()
    .showHelpAfterError()
    .option('--cli-home <dir>', 'use an isolated CLI configuration, state, and cache directory')
    .option('--config <file>', 'use this CLI JSON configuration file')
    .option('--profile <name>', 'select a connection profile')
    .addOption(
      new Option('--credential-store <backend>', 'backend used when saving secrets').choices(['keychain', 'file']),
    )
    .option('--server-url <origin>', 'Violet Map server origin')
    .option('--server-token-ref <reference>', 'server token from env:NAME, secret:NAME, or file:PATH');
}
function child(parent: Command, name: string, description: string) {
  const command = globals(new Command(name).description(description));
  parent.addCommand(command);
  return command;
}
function mergedOptions<T extends GlobalOptions>(command: Command): T {
  const scopes: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent) scopes.unshift(current);
  return Object.assign({}, ...scopes.map((scope) => scope.opts())) as T;
}
function action<T extends GlobalOptions>(
  command: Command,
  run: (options: T, args: string[]) => Promise<unknown> | unknown,
) {
  command.action(async (...args: unknown[]) => {
    await run(mergedOptions<T>(command), args.slice(0, -2) as string[]);
  });
}
function managementOptions(command: Command) {
  return command
    .addOption(new Option('--via <method>', 'management connection method (default: api)').choices(['api', 'database']))
    .option('--server-config <file>', 'server YAML configuration for database mode')
    .addOption(new Option('--database-dir <dir>', 'PGlite database directory').conflicts('databaseUrlRef'))
    .addOption(
      new Option('--database-url-ref <reference>', 'PostgreSQL connection string reference').conflicts('databaseDir'),
    );
}
function passwordOptions(command: Command) {
  return command
    .addOption(new Option('--password-stdin', 'read the password from standard input').conflicts('passwordFile'))
    .option('--password-file <file>', 'read the password from a file');
}
function s3Options(command: Command) {
  return command
    .option('--s3-bucket <bucket>', 'S3 bucket')
    .option('--s3-endpoint <url>', 'S3-compatible endpoint')
    .option('--s3-region <region>', 'S3 region')
    .option('--s3-prefix <prefix>', 'S3 key prefix')
    .addOption(new Option('--aws-profile <name>', 'AWS SDK named profile').conflicts('s3CredentialsRef'))
    .option('--s3-credentials-ref <reference>', 'JSON accessKeyId/secretAccessKey/sessionToken credential reference')
    .option('--s3-virtual-hosted', 'use virtual hosted S3 addressing');
}

export function createProgram(): Command {
  const program = globals(
    new Command('violet-map').description('Violet Map tools and administration').version(version),
  );
  program.configureOutput({ writeErr: (value) => process.stderr.write(redact(value)) });
  const config = child(program, 'config', 'Inspect CLI configuration');
  action(child(config, 'paths', 'Show effective configuration, state, and cache locations'), (options) =>
    console.log(JSON.stringify(cliPaths(options), null, 2)),
  );
  action<GlobalOptions & { sources?: boolean }>(
    child(config, 'show', 'Show selected settings without reading secrets').option('--sources', 'show setting sources'),
    async (options) => {
      const { showConfig } = await import('./commands/settings.js');
      showConfig(await loadContext(options), !!options.sources);
    },
  );
  action(child(config, 'set', 'Set CLI preferences using explicit options'), async (options) => {
    if (!options.credentialStore) throw new Error('Specify --credential-store keychain or file');
    const context = await loadContext(options, process.env, true);
    const { editConfig } = await import('./settings/config.js');
    await editConfig(context.paths, (value) => {
      value.credentialStore = options.credentialStore;
    });
    console.log(`Credential store: ${options.credentialStore}`);
  });
  const profile = child(program, 'profile', 'Manage named connections');
  action(child(profile, 'list', 'List saved profiles'), async (options) =>
    console.log(JSON.stringify((await loadContext(options)).config, null, 2)),
  );
  const set = s3Options(
    child(profile, 'set', 'Create or update a profile')
      .argument('<name>')
      .option('--database-dir <dir>', 'database directory relative to the CLI configuration')
      .option('--database-url-ref <reference>', 'database connection string reference'),
  );
  action<GlobalOptions & import('./commands/settings.js').ProfileOptions>(set, async (options, [name]) => {
    const { setProfile } = await import('./commands/settings.js');
    await setProfile(await loadContext(options, process.env, true), name, options);
  });
  action(child(profile, 'use', 'Set the default profile').argument('<name>'), async (options, [name]) => {
    const { useProfile } = await import('./commands/settings.js');
    await useProfile(await loadContext(options), name);
  });
  action(
    child(profile, 'delete', 'Remove a profile and its locally saved logins').argument('<name>'),
    async (options, [name]) => {
      const { deleteProfile } = await import('./commands/settings.js');
      await deleteProfile(await loadContext(options), name);
    },
  );
  const auth = child(program, 'auth', 'Sign in to a Violet Map server');
  action<GlobalOptions & { username: string; passwordStdin?: boolean; passwordFile?: string }>(
    passwordOptions(
      child(auth, 'login', 'Sign in and save a token bound to the server and profile').requiredOption(
        '--username <name>',
        'login username',
      ),
    ),
    async (options) => {
      const { login } = await import('./commands/session.js');
      await login(await loadContext(options, process.env, true), options);
    },
  );
  action(child(auth, 'whoami', 'Query the authenticated server identity'), async (options) => {
    const { whoami } = await import('./commands/session.js');
    await whoami(await loadContext(options));
  });
  action<GlobalOptions & { local?: boolean }>(
    child(auth, 'logout', 'Revoke the current token and clear its saved login').option(
      '--local',
      'only remove the locally saved login',
    ),
    async (options) => {
      const { logout } = await import('./commands/session.js');
      await logout(await loadContext(options), !!options.local);
    },
  );
  const users = managementOptions(
    child(program, 'users', 'Manage users through the API or a direct database connection'),
  );
  type UserOptions = GlobalOptions &
    ManagementOptions & {
      username: string;
      role: CreatableRole;
      passwordStdin?: boolean;
      passwordFile?: string;
      enable?: boolean;
      disable?: boolean;
    };
  for (const name of ['list', 'create', 'update', 'delete'] as const) {
    const command = managementOptions(child(users, name, `${name} users`));
    if (name !== 'list') command.requiredOption('--username <name>', 'target username');
    if (name === 'create' || name === 'update') {
      passwordOptions(command);
      const role = new Option('--role <role>', 'assign a non-special role').choices(roles);
      command.addOption(name === 'create' ? role.makeOptionMandatory() : role);
    }
    if (name === 'update')
      command
        .addOption(new Option('--enable', 'enable the user').conflicts('disable'))
        .option('--disable', 'disable the user');
    action<UserOptions>(command, async (options) => {
      const { withManagement } = await import('./management.js');
      const { readSecret } = await import('./input.js');
      const password =
        name === 'create' || options.passwordStdin || options.passwordFile
          ? await readSecret({ stdin: options.passwordStdin, file: options.passwordFile }, 'Password')
          : undefined;
      if (
        name === 'update' &&
        password === undefined &&
        options.role === undefined &&
        options.enable === undefined &&
        options.disable === undefined
      )
        throw new Error('Specify a password, role, --enable, or --disable');
      const result = await withManagement(await loadContext(options), options, (client) => {
        if (name === 'list') return client.users.list();
        if (name === 'create')
          return client.users.create({ username: options.username, password: password!, role: options.role });
        if (name === 'update')
          return client.users.update(options.username, {
            password,
            role: options.role,
            enabled: options.enable ? true : options.disable ? false : undefined,
          });
        return client.users.delete(options.username);
      });
      console.log(JSON.stringify(result ?? { ok: true }, null, 2));
    });
  }
  const credentials = child(program, 'credentials', 'Store credentials or issue/revoke server credentials');
  action<GlobalOptions & { stdin?: boolean; file?: string }>(
    child(credentials, 'set', 'Save a local secret and return its reference')
      .argument('<name>')
      .addOption(new Option('--stdin', 'read secret from standard input').conflicts('file'))
      .option('--file <path>', 'read secret from a file'),
    async (options, [name]) => {
      const { setCredential } = await import('./commands/settings.js');
      await setCredential(await loadContext(options), name, options);
    },
  );
  action(child(credentials, 'list', 'List local secret names and backends, without values'), async (options) => {
    const context = await loadContext(options);
    const { loadState } = await import('./settings/state.js');
    console.log(
      JSON.stringify(
        Object.entries((await loadState(context.paths)).secrets).map(([name, record]) => ({
          name,
          backend: record.backend,
        })),
        null,
        2,
      ),
    );
  });
  action(
    child(credentials, 'delete', 'Delete a local secret; does not revoke a remote token').argument('<name>'),
    async (options, [name]) => {
      const context = await loadContext(options);
      const { validName } = await import('./settings/config.js');
      validName(name);
      await context.secrets.delete(name);
      console.log('Local credential deleted.');
    },
  );
  for (const name of ['issue', 'revoke'] as const) {
    const command = managementOptions(
      child(
        credentials,
        name,
        name === 'issue'
          ? 'Issue a user credential; prints the raw token once'
          : 'Revoke all credentials belonging to a user',
      ),
    ).requiredOption('--username <name>', 'target non-special user');
    if (name === 'issue')
      command.option('--expires-in <seconds>', 'credential lifetime, 60 seconds to 365 days', integer, 3600);
    action<GlobalOptions & ManagementOptions & { username: string; expiresIn: number }>(command, async (options) => {
      const { withManagement } = await import('./management.js');
      const result = await withManagement(await loadContext(options), options, (client) =>
        name === 'issue'
          ? client.credentials.issue(options.username, options.expiresIn)
          : client.credentials.revoke(options.username),
      );
      console.log(JSON.stringify(result ?? { ok: true }, null, 2));
    });
  }
  const assets = child(program, 'assets', 'Extract Minecraft assets and generate data');
  for (const name of ['list', 'extract', 'extract-all', 'generate-biomes', 'generate-dimensions'] as const) {
    const command = child(assets, name, name.replaceAll('-', ' '));
    if (name === 'list' || name === 'extract-all') command.option('--include-snapshots', 'include snapshot versions');
    if (name === 'extract-all') command.option('--min-version <id>', 'earliest Minecraft version', '1.18');
    if (name !== 'list' && name !== 'extract-all') command.option('--version <id>', 'Minecraft version', '1.21.4');
    if (name === 'extract' || name === 'extract-all')
      command
        .option('--dir <dir>', 'output directory', './assets')
        .option('--dry-run', 'inspect without extracting assets');
    if (name === 'generate-biomes' || name === 'generate-dimensions')
      command.option(
        '--output <file>',
        'output JSON file',
        name === 'generate-biomes' ? './biomes.json' : './dimensions.json',
      );
    action<
      GlobalOptions & {
        includeSnapshots?: boolean;
        minVersion: string;
        version: string;
        dir: string;
        dryRun?: boolean;
        output: string;
      }
    >(command, async (options) => {
      const { assetCommands } = await import('./commands/assets.js');
      const tools = assetCommands(path.join(cliPaths(options).cacheDir, 'assets'));
      if (name === 'list') await tools.list(!!options.includeSnapshots);
      else if (name === 'extract') await tools.extract(options.version, options.dir, !!options.dryRun);
      else if (name === 'extract-all')
        await tools.extractAll(options.minVersion, options.dir, !!options.includeSnapshots, !!options.dryRun);
      else if (name === 'generate-biomes') await tools.generateBiomes(options.version, options.output);
      else await tools.generateDimensions(options.version, options.output);
    });
  }
  const bake = child(program, 'bake-topmap', 'Bake top-map tiles from a local world')
    .argument('<world>')
    .option('--dim <id>', 'dimension ID')
    .option('--out <dir>', 'output directory')
    .option('--limit <count>', 'maximum region count', integer)
    .option('--block-info <file>', 'block information JSON')
    .option('--biomes <file>', 'biome JSON')
    .option('--assets-dir <dirs>', 'comma-separated asset directories')
    .option('--sample-stride <blocks>', 'height sample stride', integer)
    .option('--color-stride <blocks>', 'color sample stride', integer)
    .option('--light-stride <blocks>', 'light sample stride', integer)
    .addOption(new Option('--approach <direction>', 'surface sampling direction').choices(['top', 'bottom']))
    .addOption(new Option('--light-mode <mode>', 'light baking mode').choices(['stored-first', 'rebake']))
    .option('--no-sky', 'disable sky light');
  action<GlobalOptions & import('./commands/bakeInput.js').BakeInput>(bake, async (options, [world]) => {
    const { runBakeTopMap } = await import('./commands/bake.js');
    await runBakeTopMap({ ...options, world });
  });
  const profiler = child(program, 'profile-mca', 'Profile region parsing and meshing')
    .argument('<region>')
    .option('--limit <count>', 'maximum chunk count', integer)
    .option('--rounds <count>', 'profiling rounds', integer)
    .option('--center <cx,cz>', 'center chunk')
    .option('--no-sky', 'disable sky light')
    .option('--out <file>', 'output report')
    .option('--assets-dir <dirs>', 'comma-separated asset directories')
    .option('--block-info <file>', 'block information JSON');
  action<GlobalOptions & import('./commands/profileMcaInput.js').ProfileInput>(profiler, async (options, [region]) => {
    const { runProfileMca } = await import('./commands/profileMca.js');
    await runProfileMca({ ...options, region });
  });
  const world = child(program, 'world', 'World file operations');
  const sync = s3Options(
    child(world, 'sync', 'Synchronize a local archive using identity verification')
      .requiredOption('--from <dir>', 'local source world archive')
      .requiredOption('--world <name>', 'target world name')
      .addOption(
        new Option('--target <kind>', 'destination storage').choices(['local', 's3', 'server']).default('local'),
      )
      .option('--target-dir <dir>', 'local destination worlds root')
      .option('--dry-run', 'inspect changes')
      .option('--delete', 'remove destination files absent from the source')
      .option('--force', 'allow an unverified or mismatched world identity'),
  );
  action<GlobalOptions & import('./commands/world.js').WorldSyncOptions>(sync, async (options) => {
    const { runWorldSync } = await import('./commands/world.js');
    await runWorldSync(options, await loadContext(options));
  });

  const map = child(program, 'map', 'Manage external map registrations');
  const matchOption = (command: Command) =>
    command.requiredOption('--if-match <revision>', 'explicit parent revision', integer);
  const sourceOptions = (command: Command) =>
    command
      .option('--world <key>', 'world directory key')
      .option('--unbound', 'detach the world source')
      .option('--name <name>', 'display name')
      .option('--expected-archive-id <id>', 'expected archive identity');
  for (const operation of ['register', 'list', 'show', 'rebind', 'delete']) {
    let command = child(map, operation, `${operation} map registrations`);
    if (['show', 'rebind', 'delete'].includes(operation)) command.argument('<id>');
    if (['register', 'rebind'].includes(operation)) sourceOptions(command);
    if (['rebind', 'delete'].includes(operation)) command = matchOption(command);
    action<GlobalOptions & import('./commands/content.js').ContentOptions>(command, async (options, args) => {
      if (['register', 'rebind'].includes(operation) && !!options.world === !!options.unbound)
        throw new Error('Specify exactly one of --world or --unbound');
      const { mapCommand } = await import('./commands/content.js');
      console.log(JSON.stringify(await mapCommand(await loadContext(options), operation, args, options), null, 2));
    });
  }
  const overlay = child(program, 'overlay', 'Manage external overlay layers and bindings');
  const layer = child(overlay, 'layer', 'Manage versioned overlay documents');
  for (const operation of ['validate', 'list', 'import', 'export', 'replace', 'copy', 'delete', 'revisions']) {
    let command = child(layer, operation, `${operation} overlay layer`);
    if (['validate', 'import'].includes(operation)) command.argument('<file>');
    else if (operation !== 'list') command.argument('<id>');
    if (operation === 'replace') command.argument('<file>');
    if (['replace', 'delete'].includes(operation)) command = matchOption(command);
    if (operation === 'copy') command.option('--name <name>', 'new layer name');
    if (operation === 'export')
      command
        .option('--revision <revision>', 'retained revision', integer)
        .option('--output <file>', 'write document to file');
    action<GlobalOptions & import('./commands/content.js').ContentOptions>(command, async (options, args) => {
      const { layerCommand } = await import('./commands/content.js');
      console.log(JSON.stringify(await layerCommand(await loadContext(options), operation, args, options), null, 2));
    });
  }
  for (const operation of ['bind', 'unbind', 'bindings', 'manifest']) {
    let command = child(overlay, operation, `${operation} dimension overlays`).requiredOption(
      '--map <id>',
      'map identity',
    );
    if (['bind', 'unbind'].includes(operation))
      command = matchOption(command.requiredOption('--binding <id>', 'binding identity'));
    if (['bind', 'manifest'].includes(operation)) command.requiredOption('--dimension <id>', 'dimension ID');
    if (operation === 'bind')
      command
        .requiredOption('--layer <id>', 'layer identity')
        .option('--order <integer>', 'binding order', (value) => {
          const n = Number(value);
          if (!Number.isSafeInteger(n)) throw new InvalidArgumentError('expected integer');
          return n;
        })
        .option('--disabled', 'disable this binding');
    action<GlobalOptions & import('./commands/content.js').ContentOptions>(command, async (options) => {
      const { bindingCommand } = await import('./commands/content.js');
      console.log(JSON.stringify(await bindingCommand(await loadContext(options), operation, options), null, 2));
    });
  }
  const media = child(program, 'media', 'Import and manage versioned media');
  for (const operation of ['import', 'list', 'show', 'versions', 'delete']) {
    let command = child(media, operation, `${operation} media`);
    if (operation === 'import')
      command
        .argument('<file>')
        .option('--name <name>', 'display name')
        .option('--type <mime>', 'media type')
        .option('--asset <id>', 'publish a new version of an existing asset')
        .option('--if-match <revision>', 'explicit asset revision', integer);
    else if (operation !== 'list') command.argument('<id>');
    if (operation === 'delete')
      command = matchOption(command.option('--version <id>', 'remove version from asset publication'));
    action<GlobalOptions & import('./commands/content.js').ContentOptions>(command, async (options, args) => {
      const { mediaCommand } = await import('./commands/content.js');
      console.log(JSON.stringify(await mediaCommand(await loadContext(options), operation, args, options), null, 2));
    });
  }
  program.action(() => program.help());
  return program;
}
