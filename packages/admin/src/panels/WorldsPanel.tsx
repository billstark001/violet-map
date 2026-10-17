import type { AdminSession } from '../session';
import { usePanelTask } from '../usePanelTask';
import { useAsyncResource } from '../useAsyncResource';
import { ConfirmAction } from '../ConfirmAction';
import { useCallback, useState } from 'react';
import { Badge, Box, Button, Callout, Card, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { WorldInfo } from '@violet-map/core/contracts';
import { useTranslation } from 'react-i18next';
import { VANILLA_DIMENSIONS } from '../panelShared';
import { serviceCapabilities } from '../runtime';

const REGION_COUNT_CONCURRENCY = 8;

export function WorldsPanel({ session }: { session: AdminSession }) {
  const { token } = session.getSnapshot();
  const { t } = useTranslation();
  const [newWorld, setNewWorld] = useState('demo');
  const [levelName, setLevelName] = useState('Demo');
  const { message, setMessage, busy, run } = usePanelTask();

  const load = useCallback(
    async (signal: AbortSignal) => {
      const worlds = await session.request<WorldInfo[]>('api/worlds', { signal });
      const regions: Record<string, number> = {};
      const entries = worlds.flatMap((world) => world.dimensions.map((dimension) => ({ world: world.id, dimension })));
      for (let offset = 0; offset < entries.length; offset += REGION_COUNT_CONCURRENCY) {
        await Promise.all(
          entries.slice(offset, offset + REGION_COUNT_CONCURRENCY).map(async ({ world, dimension }) => {
            const list = await session.request<unknown[]>(
              `api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dimension)}/regions`,
              { signal },
            );
            regions[`${world}|${dimension}`] = list.length;
          }),
        );
      }
      return { worlds, regions };
    },
    [session],
  );
  const {
    data: { worlds, regions },
    error,
    loading,
    reload: refresh,
  } = useAsyncResource(load, { worlds: [], regions: {} });
  const create = () =>
    run(async () => {
      const data = await session.request<{ id: string }>('api/admin/worlds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ world: newWorld, levelName, dimensions: [VANILLA_DIMENSIONS[0]] }),
      });
      setMessage({ ok: true, text: `${data.id} created` });
      await refresh();
    });
  const remove = async (id: string) => {
    const data = await session.request<{ deleted: number }>(`api/admin/worlds/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    setMessage({ ok: true, text: `${id}: deleted ${data.deleted} files` });
    await refresh();
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">{t('worlds')}</Heading>
        <Button variant="soft" onClick={() => void refresh()} disabled={loading}>
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
          <Button onClick={create} disabled={!newWorld || !token || busy}>
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
                    <ConfirmAction
                      title={t('deleteTitle', { name: w.id })}
                      description={t('deleteDescription', { name: w.id })}
                      action={() => remove(w.id)}
                    >
                      <Button size="1" variant="soft" color="red" disabled={!token || busy}>
                        {t('delete')}
                      </Button>
                    </ConfirmAction>
                  )}
                </Table.Cell>
              </Table.Row>
            )),
          )}
          {!loading && !error && !worlds.length && (
            <Table.Row>
              <Table.Cell colSpan={4}>
                <Text color="gray">{t('noWorlds')}</Text>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>
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
