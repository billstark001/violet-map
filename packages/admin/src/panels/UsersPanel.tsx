import type { AdminSession } from '../session';
import { usePanelTask } from '../usePanelTask';
import { useAsyncResource } from '../useAsyncResource';
import { ConfirmAction } from '../ConfirmAction';
import { useCallback, useState } from 'react';
import { Badge, Box, Button, Callout, Card, Flex, Heading, Select, Table, Text, TextField } from '@radix-ui/themes';
import type { PublicUser } from '@violet-map/core/contracts';
import { useTranslation } from 'react-i18next';

export function UsersPanel({ session }: { session: AdminSession }) {
  const { token } = session.getSnapshot();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'viewer' | 'ci' | 'admin'>('viewer');
  const [lifetime, setLifetime] = useState('3600');
  const { message, setMessage, busy, run } = usePanelTask();
  const [credential, setCredential] = useState<string | null>(null);

  const load = useCallback(
    (signal: AbortSignal) =>
      token ? session.request<PublicUser[]>('api/admin/users', { signal }) : Promise.resolve([]),
    [session, token],
  );
  const { data: users, error, loading, reload: refresh } = useAsyncResource(load, []);
  const create = () =>
    run(async () => {
      setCredential(null);
      const data = await session.request<PublicUser>('api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, role }),
      });
      setMessage({ ok: true, text: `${data.username} created` });
      setPassword('');
      await refresh();
    });
  const update = (user: PublicUser, patch: Partial<Pick<PublicUser, 'role' | 'enabled'>>) =>
    run(async () => {
      const data = await session.request<PublicUser>(`api/admin/users/${encodeURIComponent(user.username)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      setMessage({ ok: true, text: `${data.username} updated` });
      await refresh();
    });
  const remove = async (user: PublicUser) => {
    await session.request(`api/admin/users/${encodeURIComponent(user.username)}`, { method: 'DELETE' });
    setCredential(null);
    setMessage({ ok: true, text: `${user.username} deleted` });
    await refresh();
  };
  const issue = (user: PublicUser) =>
    run(async () => {
      setCredential(null);
      const data = await session.request<{ token: string; expiresAt: string }>(
        `api/admin/users/${encodeURIComponent(user.username)}/credentials`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expiresInSeconds: Number(lifetime) }),
        },
      );
      setMessage({ ok: true, text: `${user.username}: ${data.expiresAt}` });
      setCredential(data.token);
    });

  return (
    <Card>
      <Flex justify="between" align="center" mb="2">
        <Heading size="4">{t('users')}</Heading>
        <Button variant="soft" onClick={() => void refresh()} disabled={!token || loading || busy}>
          {t('refresh')}
        </Button>
      </Flex>
      <Text size="2" color="gray">
        {t('usersHelp')}
      </Text>
      <Flex gap="2" align="end" mb="4" mt="3" wrap="wrap">
        <Box style={{ minWidth: 150 }}>
          <Text as="label" size="1">
            {t('username')}
          </Text>
          <TextField.Root value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        </Box>
        <Box style={{ minWidth: 180 }}>
          <Text as="label" size="1">
            {t('password')}
          </Text>
          <TextField.Root type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
        </Box>
        <Box style={{ minWidth: 120 }}>
          <Text as="label" size="1">
            {t('role')}
          </Text>
          <Select.Root value={role} onValueChange={(value) => setRole(value as typeof role)}>
            <Select.Trigger />
            <Select.Content>
              {(['viewer', 'ci', 'admin'] as const).map((value) => (
                <Select.Item key={value} value={value}>
                  {value}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </Box>
        <Button disabled={!token || !username || !password || busy} onClick={create}>
          {t('createUser')}
        </Button>
      </Flex>
      <Flex gap="2" align="end" mb="3" wrap="wrap">
        <Box style={{ width: 210 }}>
          <Text as="label" size="1">
            {t('credentialLifetime')}
          </Text>
          <TextField.Root
            type="number"
            min="60"
            value={lifetime}
            onChange={(e) => setLifetime(e.currentTarget.value)}
          />
        </Box>
      </Flex>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>{t('username')}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>{t('role')}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>{t('enabled')}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {users.map((user) => (
            <Table.Row key={user.id}>
              <Table.Cell>
                {user.username}
                {user.virtual && <Badge ml="2">root</Badge>}
              </Table.Cell>
              <Table.Cell>
                {user.virtual ? (
                  user.role
                ) : (
                  <Select.Root
                    disabled={busy}
                    value={user.role}
                    onValueChange={(value) => void update(user, { role: value as PublicUser['role'] })}
                  >
                    <Select.Trigger />
                    <Select.Content>
                      {(['viewer', 'ci', 'admin'] as const).map((value) => (
                        <Select.Item key={value} value={value}>
                          {value}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                )}
              </Table.Cell>
              <Table.Cell>
                <Badge color={user.enabled ? 'green' : 'red'}>{user.enabled ? t('enabled') : t('disabled')}</Badge>
              </Table.Cell>
              <Table.Cell>
                <Flex gap="1" justify="end">
                  {!user.virtual && (
                    <>
                      <Button
                        size="1"
                        variant="soft"
                        disabled={busy}
                        onClick={() => void update(user, { enabled: !user.enabled })}
                      >
                        {user.enabled ? t('disabled') : t('enabled')}
                      </Button>
                      <Button
                        size="1"
                        variant="soft"
                        onClick={() => void issue(user)}
                        disabled={
                          !user.enabled || busy || !Number.isSafeInteger(Number(lifetime)) || Number(lifetime) < 60
                        }
                      >
                        {t('issueCredential')}
                      </Button>
                      <ConfirmAction
                        title={t('deleteTitle', { name: user.username })}
                        description={t('deleteDescription', { name: user.username })}
                        action={() => remove(user)}
                      >
                        <Button size="1" color="red" variant="soft" disabled={busy}>
                          {t('delete')}
                        </Button>
                      </ConfirmAction>
                    </>
                  )}
                </Flex>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {credential && (
        <Callout.Root mt="3" color="amber">
          <Callout.Text>
            {t('credentialIssued')}: <code style={{ wordBreak: 'break-all' }}>{credential}</code>
          </Callout.Text>
        </Callout.Root>
      )}
      {error && (
        <Callout.Root mt="3" color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {message && (
        <Callout.Root mt="3" color={message.ok ? 'green' : 'red'}>
          <Callout.Text>{message.text}</Callout.Text>
        </Callout.Root>
      )}
    </Card>
  );
}
