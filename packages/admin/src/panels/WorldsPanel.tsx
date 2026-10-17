import { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Callout, Card, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { WorldInfo } from '@violet-map/core/contracts';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../runtime';
import { authHeaders, VANILLA_DIMENSIONS } from '../panelShared';
import { serviceCapabilities } from '../runtime';

export function WorldsPanel({ token }: { token: string }) {
  const { t } = useTranslation();
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [regions, setRegions] = useState<Record<string, number>>({});
  const [newWorld, setNewWorld] = useState('demo');
  const [levelName, setLevelName] = useState('Demo');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const ws: WorldInfo[] = await (await apiFetch('api/worlds')).json();
    setWorlds(ws);
    const counts: Record<string, number> = {};
    for (const w of ws) {
      for (const d of w.dimensions) {
        const rs = await (
          await apiFetch(`api/worlds/${encodeURIComponent(w.id)}/${encodeURIComponent(d)}/regions`)
        ).json();
        counts[`${w.id}|${d}`] = rs.length;
      }
    }
    setRegions(counts);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    setMessage(null);
    const res = await apiFetch('api/admin/worlds', {
      method: 'POST',
      headers: authHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ world: newWorld, levelName, dimensions: [VANILLA_DIMENSIONS[0]] }),
    });
    const data = await res.json();
    setMessage(
      res.ok ? { ok: true, text: `${data.id} created` } : { ok: false, text: data.error ?? `HTTP ${res.status}` },
    );
    if (res.ok) void refresh();
  };

  const remove = async (id: string) => {
    const res = await apiFetch(`api/admin/worlds/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    const data = await res.json();
    setMessage(
      res.ok
        ? { ok: true, text: `${id}: deleted ${data.deleted ?? 0} files` }
        : { ok: false, text: data.error ?? `HTTP ${res.status}` },
    );
    if (res.ok) void refresh();
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">{t('worlds')}</Heading>
        <Button variant="soft" onClick={refresh}>
          {t('refresh')}
        </Button>
      </Flex>
      {serviceCapabilities().worldWrites && (
        <Flex gap="2" align="end" mb="4" wrap="wrap">
          <Box style={{ minWidth: 180 }}>
            <Text as="label" size="1" htmlFor="new-world">
              {t('worldName')}
            </Text>
            <TextField.Root id="new-world" value={newWorld} onChange={(e) => setNewWorld(e.currentTarget.value)} />
          </Box>
          <Box style={{ minWidth: 180 }}>
            <Text as="label" size="1" htmlFor="level-name">
              {t('levelName')}
            </Text>
            <TextField.Root id="level-name" value={levelName} onChange={(e) => setLevelName(e.currentTarget.value)} />
          </Box>
          <Button onClick={create} disabled={!newWorld || !token}>
            {t('createWorld')}
          </Button>
        </Flex>
      )}
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
          {worlds.flatMap((w) =>
            w.dimensions.map((d) => (
              <Table.Row key={`${w.id}|${d}`}>
                <Table.Cell>{w.id}</Table.Cell>
                <Table.Cell>
                  <Badge>{d}</Badge>
                </Table.Cell>
                <Table.Cell>{regions[`${w.id}|${d}`] ?? '…'}</Table.Cell>
                <Table.Cell>
                  {serviceCapabilities().worldWrites && (
                    <Button size="1" variant="soft" color="red" disabled={!token} onClick={() => remove(w.id)}>
                      {t('delete')}
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            )),
          )}
          {!worlds.length && (
            <Table.Row>
              <Table.Cell colSpan={4}>
                <Text color="gray">{t('noWorlds')}</Text>
              </Table.Cell>
            </Table.Row>
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
