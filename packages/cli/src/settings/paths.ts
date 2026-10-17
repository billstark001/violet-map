import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import envPaths from 'env-paths';

export interface LocationOptions {
  cliHome?: string;
  config?: string;
}

export interface CliPaths {
  configFile: string;
  stateFile: string;
  credentialFile: string;
  cacheDir: string;
  namespace: string;
}

export function cliPaths(options: LocationOptions = {}, env = process.env): CliPaths {
  if (options.cliHome === '' || options.config === '') throw new Error('CLI location options must not be empty');
  const home = options.cliHome ?? (env.VIOLET_MAP_CLI_HOME || undefined);
  const defaults = envPaths('violet-map', { suffix: '' });
  const stateBase =
    process.platform === 'linux'
      ? path.join(
          env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
            ? env.XDG_STATE_HOME
            : path.join(env.HOME ?? os.homedir(), '.local/state'),
          'violet-map',
        )
      : defaults.data;
  const stateDir = home ? path.resolve(home) : path.join(stateBase, 'cli');
  const configFile = path.resolve(
    options.config ??
      env.VIOLET_MAP_CLI_CONFIG ??
      (home ? path.join(home, 'config.json') : path.join(defaults.config, 'cli/config.json')),
  );
  return {
    configFile,
    stateFile: path.join(stateDir, 'state.json'),
    credentialFile: path.join(stateDir, 'credentials.json'),
    cacheDir: home ? path.resolve(home, 'cache') : path.join(defaults.cache, 'cli'),
    namespace: createHash('sha256').update(stateDir).digest('hex'),
  };
}
