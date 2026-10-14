# Authentication and users

[Back to README](../README.md)

The server has five ordered roles: `guest`, `viewer`, `ci`, `admin`, and `root`. `guest` is anonymous/public access; it is not a creatable account. `root` is a virtual environment-managed account and is also not creatable. `viewer` can submit diagnostics, `ci` can use world/admin storage APIs, and `admin` can manage data and users. `root` includes all permissions.

Root exists only when **both** environment variables are non-empty:

```bash
ROOT_USERNAME=operator
ROOT_PASSWORD='use-a-long-unique-secret'
```

If either variable is omitted, no root account exists. After running the server's `db:migrate`, bootstrap a normal administrator through the business CLI while the PGlite service is stopped:

```bash
pnpm violet-map users create --via database \
  --database-dir "$PWD/packages/server/data/users.pglite" \
  --username alice --role admin
```

The password is read without echo from the terminal. `--password-stdin` or `--password-file <file>` supplies it non-interactively. PostgreSQL operators can select `--via database` with `DATABASE_URL` or a credential reference. These commands perform business operations only: they verify migration history and never generate, baseline, or apply migrations.

For normal online administration, use API mode (the default):

```bash
pnpm violet-map profile set production --server-url https://map.example.com
pnpm violet-map profile use production
pnpm violet-map auth login --username alice
pnpm violet-map auth whoami
pnpm violet-map users list
pnpm violet-map users update --username another_user --role ci
pnpm violet-map users update --username another_user --disable
pnpm violet-map users delete --username another_user
pnpm violet-map credentials issue --username deploy_user --expires-in 3600
pnpm violet-map credentials revoke --username deploy_user
pnpm violet-map auth logout
```

User creation and updates reject `root` and `guest` roles. The Admin UI provides the same user CRUD, enable/disable controls, login, and credential issuance. Login produces a 12-hour bearer credential; issued user credentials last 60 seconds to 365 days. `credentials issue` intentionally prints the raw token once. Ordinary output, configuration inspection, and logs do not print stored secrets. Send API credentials with `Authorization: Bearer <token>`.

`auth logout` revokes the selected token on the server before removing its cached login. An already invalid token is also cleared; a network failure preserves the login for retry. `auth logout --local` removes only the cached login. `credentials revoke --username ...` revokes all credentials belonging to that non-special user, whereas `credentials delete <name>` only removes a local secret. Disabling/deleting a user or changing their password revokes their credentials. Every authenticated request reads the user's current role, so role changes take effect immediately.

The server is authoritative for remote access:

| Operation                                                            | Minimum role |
| -------------------------------------------------------------------- | ------------ |
| Public map reads                                                     | guest        |
| Diagnostics and current identity                                     | viewer       |
| World/storage administration and sync, including deletions           | ci           |
| User administration, issuing/revoking user credentials, biome writes | admin        |
| All API operations                                                   | root         |

Missing, expired, or revoked credentials return HTTP 401. An authenticated user with insufficient permissions receives HTTP 403. Commands report the failure without changing transport or trying another identity. Direct database mode is an explicit trusted operator channel, authorized by database credentials or filesystem permissions, and retains the same user/password/role business validation.
