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
        <Heading size="4">世界列表</Heading>
        <Button variant="soft" onClick={refresh}>刷新</Button>
      </Flex>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>世界</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>维度</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>区域文件数</Table.ColumnHeaderCell>
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
            <Table.Row><Table.Cell colSpan={3}><Text color="gray">暂无世界，请上传数据。</Text></Table.Cell></Table.Row>
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
        ? { ok: true, text: data.type === 'region' ? `已保存区域文件 ${data.name}` : `已保存区块 (${data.x}, ${data.z})` }
        : { ok: false, text: data.error ?? '上传失败' });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading size="4" mb="3">上传区块数据</Heading>
      <Text size="2" color="gray">支持标准 .mca 区域文件（文件名须为 r.X.Z.mca），或单区块 NBT（gzip/zlib/未压缩均可，须含 xPos/zPos）。</Text>
      <Flex direction="column" gap="3" mt="3" style={{ maxWidth: 420 }}>
        <TextField.Root placeholder="世界名（如 demo）" value={world} onChange={(e) => setWorld(e.target.value)} />
        <Select.Root value={dim} onValueChange={setDim}>
          <Select.Trigger />
          <Select.Content>{DIMS.map((d) => <Select.Item key={d} value={d}>{d}</Select.Item>)}</Select.Content>
        </Select.Root>
        <input type="file" accept=".mca,.nbt,.dat" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button onClick={upload} disabled={!file || !world || busy}>{busy ? '上传中…' : '上传'}</Button>
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
      setMessage(res.ok ? { ok: true, text: '已保存（前端重新加载后生效）' } : { ok: false, text: `保存失败：${res.status}` });
    } catch (e) {
      setMessage({ ok: false, text: `JSON 无效：${(e as Error).message}` });
    }
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">群系颜色数据（temperature / downfall / sky·fog·water·grass·foliage color）</Heading>
        <Button onClick={save}>保存</Button>
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
    <Theme appearance="dark" accentColor="grass">
      <Container size="3" py="5">
        <Heading mb="4">MC Renderer 管理后台</Heading>
        <Tabs.Root defaultValue="worlds">
          <Tabs.List>
            <Tabs.Trigger value="worlds">世界</Tabs.Trigger>
            <Tabs.Trigger value="upload">上传</Tabs.Trigger>
            <Tabs.Trigger value="biomes">群系数据</Tabs.Trigger>
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