# CLI configuration and credentials

[Back to README](../README.md)

## Configuration, profiles, and state

The installed executable is `violet-map`. In this workspace, `pnpm violet-map ...` runs that same command tree from source; no former executable names, `admin` entrypoints, or deprecated flag aliases are provided. Commander validates unknown options, required operands, choices, numeric values, and mutually exclusive options. Root `--version` reports the CLI release; `assets extract --version <id>` selects Minecraft. Common options may be placed before or after subcommands; when explicitly supplied at multiple scopes, the option nearest the executed command takes precedence.

CLI configuration is versioned JSON, separate from the server's deployment YAML. Settings resolve as explicit command options, then environment variables, then the selected profile, then defaults. Profile selection uses `--profile`, `VIOLET_MAP_PROFILE`, then `defaultProfile`. Ordinary commands never persist temporary overrides. Profiles change only through `profile set/use/delete`; `auth login` creates or updates its explicitly selected server profile after a successful login.

```bash
pnpm violet-map config paths
pnpm violet-map config show --sources
pnpm violet-map config set --credential-store file
pnpm violet-map profile list
pnpm violet-map profile set local --database-dir /srv/violet-map/users.pglite
pnpm violet-map profile set production --database-url-ref env:DATABASE_URL
pnpm violet-map profile set archive --s3-bucket violet-worlds --aws-profile maps
```

Example `config.json` (all fields other than `version` and `profiles` are optional):

```json
{
  "version": 1,
  "defaultProfile": "production",
  "profiles": {
    "production": {
      "server": { "url": "https://map.example.com" },
      "database": { "urlRef": "env:DATABASE_URL" }
    },
    "local": { "database": { "dir": "/srv/violet-map/users.pglite" } },
    "archive": { "s3": { "bucket": "violet-worlds", "awsProfile": "maps" } }
  }
}
```

Server URLs are normalized HTTP(S) API bases, optionally including a reverse-proxy path prefix, without query, fragment, or embedded credentials. A saved login is bound to both the profile name and normalized API base. Selecting another server does not reuse the first server's cached token. An environment token paired with a different environment server URL is rejected when a command overrides that URL.

| Location       | Default                                                       |
| -------------- | ------------------------------------------------------------- |
| macOS config   | `~/Library/Preferences/violet-map/cli/config.json`            |
| macOS state    | `~/Library/Application Support/violet-map/cli/state.json`     |
| macOS cache    | `~/Library/Caches/violet-map/cli`                             |
| Linux config   | `${XDG_CONFIG_HOME:-~/.config}/violet-map/cli/config.json`    |
| Linux state    | `${XDG_STATE_HOME:-~/.local/state}/violet-map/cli/state.json` |
| Linux cache    | `${XDG_CACHE_HOME:-~/.cache}/violet-map/cli`                  |
| Windows config | `%APPDATA%\violet-map\Config\cli\config.json`                 |
| Windows state  | `%LOCALAPPDATA%\violet-map\Data\cli\state.json`               |
| Windows cache  | `%LOCALAPPDATA%\violet-map\Cache\cli`                         |

Downloaded Minecraft assets use `cache/assets`. `state.json` contains login metadata and credential references, never secret values. Normal configuration inspection does not open the system credential store. Files are replaced atomically with exclusive writer locks; locks left after a crash require verifying that the owner has stopped before removing the corresponding `.lock` file. Malformed JSON is reported without overwriting it.

| Override | Environment equivalent | Scope |
| --- | --- | --- |
| `--cli-home <dir>` | `VIOLET_MAP_CLI_HOME` | Put `config.json`, `state.json`, `credentials.json`, and `cache/` under one isolated directory. |
| `--config <file>` | `VIOLET_MAP_CLI_CONFIG` | Replace only the CLI configuration file. |
| `--profile <name>` | `VIOLET_MAP_PROFILE` | Select the connection profile for this invocation. |
| `--server-config <file>` | `VIOLET_MAP_CONFIG` | Select deployment YAML for explicit database mode; unrelated to CLI state location. |

```bash
pnpm violet-map --cli-home /tmp/violet-map-test config paths
VIOLET_MAP_CLI_HOME=/tmp/violet-map-test pnpm violet-map profile list
pnpm violet-map --config ./operator.json --profile production users list
```

Location flags choose where the current invocation reads/writes; they do not change the platform default. Overriding only `--config` does not isolate login state. A different CLI home uses a different system-keychain namespace; the operating system still owns the physical keychain. Neither override moves a real database or world archive. CLI file paths resolve from the invocation directory; paths stored in profiles resolve from the CLI configuration file's directory; server YAML paths resolve from that YAML file's directory.

Database mode requires `--via database` and an explicit target. `--database-dir` selects PGlite even if an unrelated `DATABASE_URL` is present. `--database-url-ref` selects PostgreSQL; these two options conflict. Otherwise database environment settings take precedence over profile settings. With `--server-config`, environment settings and the selected YAML determine the target instead of a profile database target. No missing database is silently migrated. PGlite uses the same directory lock as server startup and maintenance; use API mode while its server is running.

## Credential storage

The default persistent backend is the OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. The native binding is optional and loaded only for secret operations; Linux requires Secret Service explicitly rather than silently switching to an ephemeral kernel keyring. If unavailable or locked, saving fails with an actionable error. Select `--credential-store file` for one command or `config set --credential-store file` to opt into the plaintext file backend. There is no automatic downgrade. If a replacement is saved but its old backend cannot delete the previous secret, the command reports success with a cleanup warning and retains a local reference that can be removed with `credentials delete` when the backend becomes available.

The file backend stores secrets in the state directory's `credentials.json`, with mode 0600 on Unix or a current-user ACL on Windows. New application directories use mode 0700 on Unix. This provides access control, not encryption. System-keychain entries are scoped by the CLI state location; copying a state file to another CLI home does not grant access to its keychain entries. Login passwords are never saved, and command-line/environment overrides are never copied into persistent storage automatically.

Credential references support only these forms:

| Reference | Resolution |
| --- | --- |
| `env:NAME` | Read a non-empty injected environment variable. |
| `file:PATH` | Read a secret file; profile references resolve relative to the CLI config, command-line references to the invocation directory. |
| `secret:NAME` | Read a named secret from the selected CLI state's credential records. |

```bash
pnpm violet-map credentials set database-production --file /run/secrets/database-url
pnpm violet-map profile set production --database-url-ref secret:database-production
pnpm violet-map credentials list
pnpm violet-map credentials delete database-production
pnpm violet-map users list --via database --database-url-ref file:/run/secrets/database-url
```

`credentials set <name> --stdin` also accepts piped secret input. Configuration rejects inline token/password/connection-string fields; use a reference for the entire sensitive database URL. Avoid secrets in argv or checked-in files. CI can inject `VIOLET_SERVER_URL`/`VIOLET_SERVER_TOKEN` directly, or use `--server-token-ref env:NAME|file:PATH|secret:NAME`. Command-line token references override environment tokens; environment tokens override a matching cached login. Explicitly missing credentials fail without falling back. Use HTTPS for remote servers.

S3 uses the AWS SDK's default provider chain when no provider is selected, including AWS environment variables, shared configuration, SSO, and workload roles. `--aws-profile <name>` selects a named SDK profile. Custom S3 credentials can be supplied using `--s3-credentials-ref` or profile `s3.credentialsRef`, containing JSON with `accessKeyId`, `secretAccessKey`, and an optional `sessionToken`. An explicit provider overrides environment/profile providers; environment providers override profile providers. `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` must be supplied together, with optional `S3_SESSION_TOKEN`. Temporary credentials and refreshable providers are supported without copying AWS credentials into CLI configuration.

## Optional command capabilities

The only mandatory workspace package is core. Install optional peers in the same npm project as `@violet-map/cli`; a global CLI needs its peers in the global dependency environment. Versions must match the workspace release line (currently 0.1.x). `npm install @violet-map/cli @violet-map/render` enables `bake-topmap` and `profile-mca`; add `@violet-map/storage` for `world sync`, or `@violet-map/server` for explicit database administration. API login/users/credentials, help/version/config/profiles, file credential storage and asset extraction/generation work without these peers. Registration and `--help` never load optional implementations. Missing peers give a command-specific installation error; installed implementation errors are preserved. The native keyring retains its existing explicit file-backend fallback policy.

Asset directories resolve from explicit `--assets-dir`, then `ASSETS_DIRS`, then `assets` under the invocation directory. Shared biome/dimension/block defaults are packaged in core; no CLI command searches server source directories.
