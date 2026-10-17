import type { AdminSession } from '../session';
import { usePanelTask } from '../usePanelTask';
import { useState } from 'react';
import { Button, Callout, Card, Flex, Heading, Select, Text, TextField } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { VANILLA_DIMENSIONS } from '../panelShared';

export function UploadPanel({ session }: { session: AdminSession }) {
  const { token } = session.getSnapshot();
  const { t } = useTranslation();
  const [world, setWorld] = useState('demo');
  const [dim, setDim] = useState(VANILLA_DIMENSIONS[0]);
  const [file, setFile] = useState<File | null>(null);
  const { message, setMessage, busy, run } = usePanelTask();

  const upload = () =>
    run(async () => {
      if (!file) throw new Error(t('missingFile'));
      const form = new FormData();
      form.set('file', file);
      form.set('dim', dim);
      const data = await session.request<{ type: string; name?: string; x?: number; z?: number }>(
        `api/admin/worlds/${encodeURIComponent(world)}/upload`,
        { method: 'POST', body: form },
      );
      setMessage({
        ok: true,
        text: data.type === 'region' ? `Saved region file ${data.name}` : `Saved chunk (${data.x}, ${data.z})`,
      });
    });

  return (
    <Card>
      <Heading size="4" mb="3">
        {t('uploadChunkData')}
      </Heading>
      <Text size="2" color="gray">
        {t('uploadHelp')}
      </Text>
      <Flex direction="column" gap="3" mt="3" style={{ maxWidth: 420 }}>
        <TextField.Root
          placeholder="World name, for example demo"
          value={world}
          onChange={(e) => setWorld(e.target.value)}
        />
        <Select.Root value={dim} onValueChange={setDim}>
          <Select.Trigger />
          <Select.Content>
            {VANILLA_DIMENSIONS.map((d) => (
              <Select.Item key={d} value={d}>
                {d}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <input type="file" accept=".mca,.nbt,.dat" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button onClick={upload} disabled={!file || !world || busy || !token}>
          {busy ? t('uploading') : t('upload')}
        </Button>
        {message && (
          <Callout.Root color={message.ok ? 'green' : 'red'}>
            <Callout.Text>{message.text}</Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    </Card>
  );
}
