import { cliPaths, type LocationOptions, type CliPaths } from './settings/paths.js';
import {
  loadConfig,
  selectProfile,
  validName,
  type CliConfig,
  type Profile,
  type CredentialBackend,
} from './settings/config.js';
import { SecretStore } from './settings/secrets.js';

export interface GlobalOptions extends LocationOptions {
  profile?: string;
  credentialStore?: CredentialBackend;
  serverUrl?: string;
  serverTokenRef?: string;
}
export interface CliContext {
  options: GlobalOptions;
  paths: CliPaths;
  config: CliConfig;
  profile: Profile;
  profileName?: string;
  secrets: SecretStore;
  env: NodeJS.ProcessEnv;
}
export async function loadContext(
  options: GlobalOptions,
  env = process.env,
  allowNewProfile = false,
): Promise<CliContext> {
  const paths = cliPaths(options, env);
  const config = await loadConfig(paths, !allowNewProfile && !!(options.config ?? env.VIOLET_MAP_CLI_CONFIG));
  const name = options.profile ?? env.VIOLET_MAP_PROFILE ?? config.defaultProfile;
  if (name) validName(name);
  const selected =
    allowNewProfile && name && !Object.hasOwn(config.profiles, name)
      ? { name, profile: {} }
      : selectProfile(config, name);
  return {
    options,
    paths,
    config,
    profile: selected.profile,
    profileName: selected.name,
    env,
    secrets: new SecretStore(paths, options.credentialStore ?? config.credentialStore ?? 'keychain', env),
  };
}
