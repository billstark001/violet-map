import { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Callout, Card, Flex, Heading, Select, Table, Text, TextField } from '@radix-ui/themes';
import type { PublicUser } from '@violet-map/core/contracts';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../runtime';
import { authHeaders } from '../panelShared';

export function UsersPanel({ token }: { token: string }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'viewer' | 'ci' | 'admin'>('viewer');
  const [lifetime, setLifetime] = useState('3600');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [credential, setCredential] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch('api/admin/users', { headers: authHeaders(token) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setUsers((await res.json()) as PublicUser[]);
  }, [token]);
  useEffect(() => {
    if (token) void refresh().catch((error) => setMessage({ ok: false, text: String(error) }));
  }, [token, refresh]);

  const create = async () => {
    setCredential(null);
    const res = await apiFetch('api/admin/users', {
      method: 'POST',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ username, password, role }),
    });
    const data = await res.json();
    setMessage(
      res.ok ? { ok: true, text: `${data.username} created` } : { ok: false, text: data.error ?? `HTTP ${res.status}` },
    );
    if (res.ok) {
      setPassword('');
      void refresh();
    }
  };
  const update = async (user: PublicUser, patch: Partial<Pick<PublicUser, 'role' | 'enabled'>>) => {
    const res = await apiFetch(`api/admin/users/${encodeURIComponent(user.username)}`, {
      method: 'PATCH',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    setMessage(
      res.ok ? { ok: true, text: `${data.username} updated` } : { ok: false, text: data.error ?? `HTTP ${res.status}` },
    );
    if (res.ok) void refresh();
  };
  const remove = async (user: PublicUser) => {
    const res = await apiFetch(`api/admin/users/${encodeURIComponent(user.username)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    const data = await res.json();
    setMessage(
      res.ok ? { ok: true, text: `${user.username} deleted` } : { ok: false, text: data.error ?? `HTTP ${res.status}` },
    );
    if (res.ok) void refresh();
  };
  const issue = async (user: PublicUser) => {
    setCredential(null);
    const res = await apiFetch(`api/admin/users/${encodeURIComponent(user.username)}/credentials`, {
      method: 'POST',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ expiresInSeconds: Number(lifetime) }),
    });
    const data = await res.json();
    setMessage(
      res.ok
        ? { ok: true, text: `${user.username}: ${data.expiresAt}` }
        : { ok: false, text: data.error ?? `HTTP ${res.status}` },
    );
    if (res.ok) setCredential(data.token);
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="2">
        <Heading size="4">{t('users')}</Heading>
        <Button variant="soft" onClick={() => void refresh()} disabled={!token}>
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
        <Button disabled={!token || !username || !password} onClick={create}>
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
                      <Button size="1" variant="soft" onClick={() => void update(user, { enabled: !user.enabled })}>
                        {user.enabled ? t('disabled') : t('enabled')}
                      </Button>
                      <Button size="1" variant="soft" onClick={() => void issue(user)} disabled={!user.enabled}>
                        {t('issueCredential')}
                      </Button>
                      <Button size="1" color="red" variant="soft" onClick={() => void remove(user)}>
                        {t('delete')}
                      </Button>
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
      {message && (
        <Callout.Root mt="3" color={message.ok ? 'green' : 'red'}>
          <Callout.Text>{message.text}</Callout.Text>
        </Callout.Root>
      )}
    </Card>
  );
}
