import { useEffect, useState } from 'react';
import { Button, Callout, Card, Flex, Heading, TextArea } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../runtime';
import { authHeaders } from '../panelShared';

export function BiomesPanel({ token }: { token: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    apiFetch('api/data/biomes')
      .then((r) => r.json())
      .then((j) => setText(JSON.stringify(j, null, 2)));
  }, []);

  const save = async () => {
    try {
      const parsed = JSON.parse(text);
      const res = await apiFetch('api/data/biomes', {
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
        <Button onClick={save} disabled={!token}>
          {t('save')}
        </Button>
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
