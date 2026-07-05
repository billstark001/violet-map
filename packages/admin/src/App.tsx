import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Box, Button, Callout, Card, Container, Flex, Heading, Select, Table, Tabs, Text,
  TextArea, TextField, Theme,
} from '@radix-ui/themes';

interface WorldInfo { id: string; dimensions: string[] }
const DIMS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];

function WorldsPanel() {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [regions, setRegions] = useState<Record<string, number>>({});

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

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">Worlds</Heading>
        <Button variant="soft" onClick={refresh}>Refresh</Button>
      </Flex>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>World</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Dimension</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Region files</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {worlds.flatMap((w) => w.dimensions.map((d) => (
            <Table.Row key={`${w.id}|${d}`}>
              <Table.Cell>{w.id}</Table.Cell>
              <Table.Cell><Badge>{d}</Badge></Table.Cell>
              <Table.Cell>{regions[`${w.id}|${d}`] ?? '…'}</Table.Cell>
            </Table.Row>
          )))}
          {!worlds.length && (
            <Table.Row><Table.Cell colSpan={3}><Text color="gray">No worlds found. Upload data to get started.</Text></Table.Cell></Table.Row>
          )}
        </Table.Body>
      </Table.Root>
    </Card>
  );
}

function UploadPanel() {
  const [world, setWorld] = useState('demo');
  const [dim, setDim] = useState(DIMS[0]);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('world', world);
      form.set('dim', dim);
      const res = await fetch('/api/admin/upload', { method: 'POST', body: form });
      const data = await res.json();
      setMessage(res.ok
        ? { ok: true, text: data.type === 'region' ? `Saved region file ${data.name}` : `Saved chunk (${data.x}, ${data.z})` }
        : { ok: false, text: data.error ?? 'Upload failed' });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading size="4" mb="3">Upload Chunk Data</Heading>
      <Text size="2" color="gray">Supports standard .mca region files named r.X.Z.mca, or individual chunk NBT files using gzip, zlib, or raw NBT with xPos/zPos.</Text>
      <Flex direction="column" gap="3" mt="3" style={{ maxWidth: 420 }}>
        <TextField.Root placeholder="World name, for example demo" value={world} onChange={(e) => setWorld(e.target.value)} />
        <Select.Root value={dim} onValueChange={setDim}>
          <Select.Trigger />
          <Select.Content>{DIMS.map((d) => <Select.Item key={d} value={d}>{d}</Select.Item>)}</Select.Content>
        </Select.Root>
        <input type="file" accept=".mca,.nbt,.dat" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button onClick={upload} disabled={!file || !world || busy}>{busy ? 'Uploading...' : 'Upload'}</Button>
        {message && (
          <Callout.Root color={message.ok ? 'green' : 'red'}>
            <Callout.Text>{message.text}</Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    </Card>
  );
}

function BiomesPanel() {
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
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      setMessage(res.ok ? { ok: true, text: 'Saved. Reload the viewer to apply changes.' } : { ok: false, text: `Save failed: ${res.status}` });
    } catch (e) {
      setMessage({ ok: false, text: `Invalid JSON: ${(e as Error).message}` });
    }
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">Biome Color Data (temperature / downfall / sky / fog / water / grass / foliage)</Heading>
        <Button onClick={save}>Save</Button>
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
  return (
    <Theme appearance="dark" accentColor="violet">
      <Container size="3" py="5">
        <Heading mb="4">Violet Map Admin</Heading>
        <Tabs.Root defaultValue="worlds">
          <Tabs.List>
            <Tabs.Trigger value="worlds">Worlds</Tabs.Trigger>
            <Tabs.Trigger value="upload">Upload</Tabs.Trigger>
            <Tabs.Trigger value="biomes">Biomes</Tabs.Trigger>
          </Tabs.List>
          <Box mt="4">
            <Tabs.Content value="worlds"><WorldsPanel /></Tabs.Content>
            <Tabs.Content value="upload"><UploadPanel /></Tabs.Content>
            <Tabs.Content value="biomes"><BiomesPanel /></Tabs.Content>
          </Box>
        </Tabs.Root>
      </Container>
    </Theme>
  );
}
