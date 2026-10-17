import type { AdminSession } from '../session';
import { usePanelTask } from '../usePanelTask';
import { useAsyncResource } from '../useAsyncResource';
import { useCallback, useState } from 'react';
import { Button, Callout, Card, Flex, Heading, TextArea } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';

export function BiomesPanel({ session }: { session: AdminSession }) {
  const { token } = session.getSnapshot();
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const { message, setMessage, busy, run } = usePanelTask();

  const load = useCallback(
    async (signal: AbortSignal) => JSON.stringify(await session.request('api/data/biomes', { signal }), null, 2),
    [session],
  );
  const { data, error, loading } = useAsyncResource(load, '');
  const text = draft ?? data;
  const save = () =>
    run(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      await session.request('api/data/biomes', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      setMessage({ ok: true, text: t('saved') });
    });

  return (
    <Card>
      <Flex justify="between" align="center" mb="3">
        <Heading size="4">{t('biomeTitle')}</Heading>
        <Button onClick={save} disabled={!token || busy || loading || !!error}>
          {t('save')}
        </Button>
      </Flex>
      <TextArea value={text} onChange={(e) => setDraft(e.target.value)} rows={24} style={{ fontFamily: 'monospace' }} />
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
