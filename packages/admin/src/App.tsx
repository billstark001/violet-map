import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Box, Button, Callout, Card, Container, Flex, Heading, Select, Table, Tabs, Text,
  TextArea, TextField, Theme,
} from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { languageOptions } from './i18n';

interface WorldInfo { id: string; dimensions: string[] }
const DIMS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
const ADMIN_TOKEN_KEY = 'violet-map:admin-token';

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return token ? { ...headers, 'x-violet-admin-token': token } : headers;
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
      form.set('world', world);
      form.set('dim', dim);
      const res = await fetch('/api/admin/upload', { method: 'POST', headers: authHeaders(token), body: form });
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

export default function App() {
  const { t, i18n } = useTranslation();
  const [token, setToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) ?? '');
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
  return (
    <Theme appearance="dark" accentColor="violet">
      <Container size="3" py="5">
        <Flex justify="between" align="end" gap="3" mb="4" wrap="wrap">
          <Heading>{t('title')}</Heading>
          <Flex gap="2" align="end" wrap="wrap">
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
        <Tabs.Root defaultValue="worlds">
          <Tabs.List>
            <Tabs.Trigger value="worlds">{t('worlds')}</Tabs.Trigger>
            <Tabs.Trigger value="upload">{t('upload')}</Tabs.Trigger>
            <Tabs.Trigger value="biomes">{t('biomes')}</Tabs.Trigger>
          </Tabs.List>
          <Box mt="4">
            <Tabs.Content value="worlds"><WorldsPanel token={token} /></Tabs.Content>
            <Tabs.Content value="upload"><UploadPanel token={token} /></Tabs.Content>
            <Tabs.Content value="biomes"><BiomesPanel token={token} /></Tabs.Content>
          </Box>
        </Tabs.Root>
      </Container>
    </Theme>
  );
}
