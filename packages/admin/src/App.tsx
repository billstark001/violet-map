import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Box, Button, Callout, Card, Container, Flex, Heading, Select, Table, Tabs, Text,
  TextArea, TextField, Theme,
} from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { languageOptions } from './i18n';

interface WorldInfo { id: string; dimensions: string[] }
interface UserInfo {
  id: string;
  username: string;
  role: 'root' | 'admin' | 'ci' | 'viewer' | 'guest';
  enabled: boolean;
  virtual?: boolean;
}
const DIMS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
const ADMIN_TOKEN_KEY = 'violet-map:admin-token';

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
}

function WorldsPanel({ token }: { token: string }) {
  const { t } = useTranslation();
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [regions, setRegions] = useState<Record<string, number>>({});
  const [newWorld, setNewWorld] = useState('demo');
  const [levelName, setLevelName] = useState('Demo');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const ws: WorldInfo[] = await (await fetch('/api/worlds')).json();
    setWorlds(ws);
    const counts: Record<string, number> = {};
    for (const w of ws) {
      for (const d of w.dimensions) {
        const rs = await (await fetch(`/api/worlds/${w.id}/${d}/regions`)).json();
        counts[`${w.id}|${d}`] = rs.length;
      }
    }
    setRegions(counts);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    setMessage(null);
    const res = await fetch('/api/admin/worlds', {
      method: 'POST',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ world: newWorld, levelName, dimensions: [DIMS[0]] }),
    });
    const data = await res.json();
    setMessage(res.ok ? { ok: true, text: `${data.id} created` } : { ok: false, text: data.error ?? `HTTP ${res.status}` });
    if (res.ok) void refresh();
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/admin/worlds/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    const data = await res.json();
    setMessage(res.ok ? { ok: true, text: `${id}: deleted ${data.deleted ?? 0} files` } : { ok: false, text: data.error ?? `HTTP ${res.status}` });
    if (res.ok) void refresh();
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">{t('worlds')}</Heading>
        <Button variant="soft" onClick={refresh}>{t('refresh')}</Button>
      </Flex>
      <Flex gap="2" align="end" mb="4" wrap="wrap">
        <Box style={{ minWidth: 180 }}>
          <Text as="label" size="1" htmlFor="new-world">{t('worldName')}</Text>
          <TextField.Root id="new-world" value={newWorld} onChange={(e) => setNewWorld(e.currentTarget.value)} />
        </Box>
        <Box style={{ minWidth: 180 }}>
          <Text as="label" size="1" htmlFor="level-name">{t('levelName')}</Text>
          <TextField.Root id="level-name" value={levelName} onChange={(e) => setLevelName(e.currentTarget.value)} />
        </Box>
        <Button onClick={create} disabled={!newWorld || !token}>{t('createWorld')}</Button>
      </Flex>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>{t('world')}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>{t('dimension')}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>{t('regions')}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {worlds.flatMap((w) => w.dimensions.map((d) => (
            <Table.Row key={`${w.id}|${d}`}>
              <Table.Cell>{w.id}</Table.Cell>
              <Table.Cell><Badge>{d}</Badge></Table.Cell>
              <Table.Cell>{regions[`${w.id}|${d}`] ?? '…'}</Table.Cell>
              <Table.Cell>
                <Button size="1" variant="soft" color="red" disabled={!token} onClick={() => remove(w.id)}>{t('delete')}</Button>
              </Table.Cell>
            </Table.Row>
          )))}
          {!worlds.length && (
            <Table.Row><Table.Cell colSpan={4}><Text color="gray">{t('noWorlds')}</Text></Table.Cell></Table.Row>
          )}
        </Table.Body>
      </Table.Root>
      {message && (
        <Callout.Root mt="3" color={message.ok ? 'green' : 'red'}>
          <Callout.Text>{message.text}</Callout.Text>
        </Callout.Root>
      )}
    </Card>
  );
}

function UploadPanel({ token }: { token: string }) {
  const { t } = useTranslation();
  const [world, setWorld] = useState('demo');
  const [dim, setDim] = useState(DIMS[0]);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    if (!file) {
      setMessage({ ok: false, text: t('missingFile') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('dim', dim);
      const res = await fetch(`/api/admin/worlds/${encodeURIComponent(world)}/upload`, { method: 'POST', headers: authHeaders(token), body: form });
      const data = await res.json();
      setMessage(res.ok
        ? { ok: true, text: data.type === 'region' ? `Saved region file ${data.name}` : `Saved chunk (${data.x}, ${data.z})` }
        : { ok: false, text: data.error ?? t('uploadFailed') });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading size="4" mb="3">{t('uploadChunkData')}</Heading>
      <Text size="2" color="gray">{t('uploadHelp')}</Text>
      <Flex direction="column" gap="3" mt="3" style={{ maxWidth: 420 }}>
        <TextField.Root placeholder="World name, for example demo" value={world} onChange={(e) => setWorld(e.target.value)} />
        <Select.Root value={dim} onValueChange={setDim}>
          <Select.Trigger />
          <Select.Content>{DIMS.map((d) => <Select.Item key={d} value={d}>{d}</Select.Item>)}</Select.Content>
        </Select.Root>
        <input type="file" accept=".mca,.nbt,.dat" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button onClick={upload} disabled={!file || !world || busy || !token}>{busy ? t('uploading') : t('upload')}</Button>
        {message && (
          <Callout.Root color={message.ok ? 'green' : 'red'}>
            <Callout.Text>{message.text}</Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    </Card>
  );
}

function BiomesPanel({ token }: { token: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/data/biomes').then((r) => r.json()).then((j) => setText(JSON.stringify(j, null, 2)));
  }, []);

  const save = async () => {
    try {
      const parsed = JSON.parse(text);
      const res = await fetch('/api/data/biomes', {
        method: 'PUT',
        headers: authHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify(parsed),
      });
      setMessage(res.ok ? { ok: true, text: t('saved') } : { ok: false, text: `Save failed: ${res.status}` });
    } catch (e) {
      setMessage({ ok: false, text: `Invalid JSON: ${(e as Error).message}` });
    }
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">{t('biomeTitle')}</Heading>
        <Button onClick={save} disabled={!token}>{t('save')}</Button>
      </Flex>
      <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={24} style={{ fontFamily: 'monospace' }} />
      {message && (
        <Callout.Root mt="3" color={message.ok ? 'green' : 'red'}>
          <Callout.Text>{message.text}</Callout.Text>
        </Callout.Root>
      )}
    </Card>
  );
}

function UsersPanel({ token }: { token: string }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'viewer' | 'ci' | 'admin'>('viewer');
  const [lifetime, setLifetime] = useState('3600');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [credential, setCredential] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/users', { headers: authHeaders(token) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setUsers(await res.json() as UserInfo[]);
  }, [token]);
  useEffect(() => { if (token) void refresh().catch((error) => setMessage({ ok: false, text: String(error) })); }, [token, refresh]);

  const create = async () => {
    setCredential(null);
    const res = await fetch('/api/admin/users', {
      method: 'POST', headers: authHeaders(token, { 'content-type': 'application/json' }), body: JSON.stringify({ username, password, role }),
    });
    const data = await res.json();
    setMessage(res.ok ? { ok: true, text: `${data.username} created` } : { ok: false, text: data.error ?? `HTTP ${res.status}` });
    if (res.ok) { setPassword(''); void refresh(); }
  };
  const update = async (user: UserInfo, patch: Partial<Pick<UserInfo, 'role' | 'enabled'>>) => {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(user.username)}`, {
      method: 'PATCH', headers: authHeaders(token, { 'content-type': 'application/json' }), body: JSON.stringify(patch),
    });
    const data = await res.json();
    setMessage(res.ok ? { ok: true, text: `${data.username} updated` } : { ok: false, text: data.error ?? `HTTP ${res.status}` });
    if (res.ok) void refresh();
  };
  const remove = async (user: UserInfo) => {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(user.username)}`, { method: 'DELETE', headers: authHeaders(token) });
    const data = await res.json();
    setMessage(res.ok ? { ok: true, text: `${user.username} deleted` } : { ok: false, text: data.error ?? `HTTP ${res.status}` });
    if (res.ok) void refresh();
  };
  const issue = async (user: UserInfo) => {
    setCredential(null);
    const res = await fetch(`/api/admin/users/${encodeURIComponent(user.username)}/credentials`, {
      method: 'POST', headers: authHeaders(token, { 'content-type': 'application/json' }), body: JSON.stringify({ expiresInSeconds: Number(lifetime) }),
    });
    const data = await res.json();
    setMessage(res.ok ? { ok: true, text: `${user.username}: ${data.expiresAt}` } : { ok: false, text: data.error ?? `HTTP ${res.status}` });
    if (res.ok) setCredential(data.token);
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="2"><Heading size="4">{t('users')}</Heading><Button variant="soft" onClick={() => void refresh()} disabled={!token}>{t('refresh')}</Button></Flex>
      <Text size="2" color="gray">{t('usersHelp')}</Text>
      <Flex gap="2" align="end" mb="4" mt="3" wrap="wrap">
        <Box style={{ minWidth: 150 }}><Text as="label" size="1">{t('username')}</Text><TextField.Root value={username} onChange={(e) => setUsername(e.currentTarget.value)} /></Box>
        <Box style={{ minWidth: 180 }}><Text as="label" size="1">{t('password')}</Text><TextField.Root type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} /></Box>
        <Box style={{ minWidth: 120 }}><Text as="label" size="1">{t('role')}</Text><Select.Root value={role} onValueChange={(value) => setRole(value as typeof role)}><Select.Trigger /><Select.Content>{(['viewer', 'ci', 'admin'] as const).map((value) => <Select.Item key={value} value={value}>{value}</Select.Item>)}</Select.Content></Select.Root></Box>
        <Button disabled={!token || !username || !password} onClick={create}>{t('createUser')}</Button>
      </Flex>
      <Flex gap="2" align="end" mb="3" wrap="wrap">
        <Box style={{ width: 210 }}><Text as="label" size="1">{t('credentialLifetime')}</Text><TextField.Root type="number" min="60" value={lifetime} onChange={(e) => setLifetime(e.currentTarget.value)} /></Box>
      </Flex>
      <Table.Root>
        <Table.Header><Table.Row><Table.ColumnHeaderCell>{t('username')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t('role')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t('enabled')}</Table.ColumnHeaderCell><Table.ColumnHeaderCell /></Table.Row></Table.Header>
        <Table.Body>{users.map((user) => <Table.Row key={user.id}>
          <Table.Cell>{user.username}{user.virtual && <Badge ml="2">root</Badge>}</Table.Cell>
          <Table.Cell>{user.virtual ? user.role : <Select.Root value={user.role} onValueChange={(value) => void update(user, { role: value as UserInfo['role'] })}><Select.Trigger /><Select.Content>{(['viewer', 'ci', 'admin'] as const).map((value) => <Select.Item key={value} value={value}>{value}</Select.Item>)}</Select.Content></Select.Root>}</Table.Cell>
          <Table.Cell><Badge color={user.enabled ? 'green' : 'red'}>{user.enabled ? t('enabled') : t('disabled')}</Badge></Table.Cell>
          <Table.Cell><Flex gap="1" justify="end">{!user.virtual && <><Button size="1" variant="soft" onClick={() => void update(user, { enabled: !user.enabled })}>{user.enabled ? t('disabled') : t('enabled')}</Button><Button size="1" variant="soft" onClick={() => void issue(user)} disabled={!user.enabled}>{t('issueCredential')}</Button><Button size="1" color="red" variant="soft" onClick={() => void remove(user)}>{t('delete')}</Button></>}</Flex></Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table.Root>
      {credential && <Callout.Root mt="3" color="amber"><Callout.Text>{t('credentialIssued')}: <code style={{ wordBreak: 'break-all' }}>{credential}</code></Callout.Text></Callout.Root>}
      {message && <Callout.Root mt="3" color={message.ok ? 'green' : 'red'}><Callout.Text>{message.text}</Callout.Text></Callout.Root>}
    </Card>
  );
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) ?? '');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const changeToken = (value: string) => {
    setToken(value);
    try {
      localStorage.setItem(ADMIN_TOKEN_KEY, value);
    } catch {
      // Ignore storage failures.
    }
  };
  const changeLanguage = (lng: string) => {
    void i18n.changeLanguage(lng);
    try {
      localStorage.setItem('violet-map:language', lng);
    } catch {
      // Ignore storage failures.
    }
  };
  const signIn = async () => {
    setLoginMessage(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: loginUsername, password: loginPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.token !== 'string') { setLoginMessage(data.error ?? t('signInFailed')); return; }
    changeToken(data.token);
    setLoginPassword('');
  };
  return (
    <Theme appearance="dark" accentColor="violet">
      <Container size="3" py="5">
        <Flex justify="between" align="end" gap="3" mb="4" wrap="wrap">
          <Heading>{t('title')}</Heading>
          <Flex gap="2" align="end" wrap="wrap">
            <Box style={{ width: 150 }}>
              <Text as="label" size="1" htmlFor="login-username">{t('username')}</Text>
              <TextField.Root id="login-username" autoComplete="username" value={loginUsername} onChange={(e) => setLoginUsername(e.currentTarget.value)} />
            </Box>
            <Box style={{ width: 150 }}>
              <Text as="label" size="1" htmlFor="login-password">{t('password')}</Text>
              <TextField.Root id="login-password" type="password" autoComplete="current-password" value={loginPassword} onChange={(e) => setLoginPassword(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') void signIn(); }} />
            </Box>
            <Button variant="soft" onClick={() => void signIn()} disabled={!loginUsername || !loginPassword}>{t('signIn')}</Button>
            <Box style={{ width: 220 }}>
              <Text as="label" size="1" htmlFor="admin-token">{t('token')}</Text>
              <TextField.Root id="admin-token" type="password" value={token} onChange={(e) => changeToken(e.currentTarget.value)} />
            </Box>
            <Box style={{ width: 160 }}>
              <Text as="label" size="1">{t('language')}</Text>
              <Select.Root value={i18n.resolvedLanguage ?? i18n.language} onValueChange={changeLanguage}>
                <Select.Trigger />
                <Select.Content>
                  {languageOptions.map((l) => <Select.Item key={l.value} value={l.value}>{l.label}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            </Box>
          </Flex>
        </Flex>
        {loginMessage && <Callout.Root mb="3" color="red"><Callout.Text>{loginMessage}</Callout.Text></Callout.Root>}
        <Tabs.Root defaultValue="worlds">
          <Tabs.List>
            <Tabs.Trigger value="worlds">{t('worlds')}</Tabs.Trigger>
            <Tabs.Trigger value="upload">{t('upload')}</Tabs.Trigger>
            <Tabs.Trigger value="biomes">{t('biomes')}</Tabs.Trigger>
            <Tabs.Trigger value="users">{t('users')}</Tabs.Trigger>
          </Tabs.List>
          <Box mt="4">
            <Tabs.Content value="worlds"><WorldsPanel token={token} /></Tabs.Content>
            <Tabs.Content value="upload"><UploadPanel token={token} /></Tabs.Content>
            <Tabs.Content value="biomes"><BiomesPanel token={token} /></Tabs.Content>
            <Tabs.Content value="users"><UsersPanel token={token} /></Tabs.Content>
          </Box>
        </Tabs.Root>
      </Container>
    </Theme>
  );
}
