import { useState, type ReactElement } from 'react';
import { AlertDialog, Button, Callout, Flex } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { usePanelTask } from './usePanelTask';

/** Keep destructive confirmation open on failure; close only after completion. */
export function ConfirmAction({
  children,
  title,
  description,
  action,
}: {
  children: ReactElement;
  title: string;
  description: string;
  action: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { busy, message, setMessage, run } = usePanelTask();
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setMessage(null);
        }
      }}
    >
      <AlertDialog.Trigger>{children}</AlertDialog.Trigger>
      <AlertDialog.Content maxWidth="440px">
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description}</AlertDialog.Description>
        {message && (
          <Callout.Root color="red" mt="3" role="alert">
            <Callout.Text>{message.text}</Callout.Text>
          </Callout.Root>
        )}
        <Flex gap="3" justify="end" mt="4">
          <AlertDialog.Cancel>
            <Button variant="soft" disabled={busy}>
              {t('cancel')}
            </Button>
          </AlertDialog.Cancel>
          <Button
            color="red"
            disabled={busy}
            onClick={async () => {
              if (await run(action)) setOpen(false);
            }}
          >
            {t('confirmDelete')}
          </Button>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
