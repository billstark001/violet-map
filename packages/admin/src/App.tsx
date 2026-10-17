import { serviceCapabilities } from './runtime';
import { Box, Callout, Container, Tabs, Theme } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { Header } from './Header';
import { useAdminSession } from './useSession';
import { WorldsPanel } from './panels/WorldsPanel';
import { UploadPanel } from './panels/UploadPanel';
import { BiomesPanel } from './panels/BiomesPanel';
import { UsersPanel } from './panels/UsersPanel';

export default function App() {
  const { t } = useTranslation();
  const { session, state } = useAdminSession();
  return (
    <Theme appearance="dark" accentColor="violet">
      <Container size="3" py="5">
        <Header session={session} state={state} />
        {!serviceCapabilities().adminApi ? (
          <Callout.Root>
            <Callout.Text>This server has not enabled management features.</Callout.Text>
          </Callout.Root>
        ) : (
          <Tabs.Root key={state.token} defaultValue="worlds">
            <Tabs.List>
              <Tabs.Trigger value="worlds">{t('worlds')}</Tabs.Trigger>
              {serviceCapabilities().worldWrites && <Tabs.Trigger value="upload">{t('upload')}</Tabs.Trigger>}
              {serviceCapabilities().dataWrites && <Tabs.Trigger value="biomes">{t('biomes')}</Tabs.Trigger>}
              {serviceCapabilities().users && <Tabs.Trigger value="users">{t('users')}</Tabs.Trigger>}
            </Tabs.List>
            <Box mt="4">
              <Tabs.Content value="worlds">
                <WorldsPanel session={session} />
              </Tabs.Content>
              {serviceCapabilities().worldWrites && (
                <Tabs.Content value="upload">
                  <UploadPanel session={session} />
                </Tabs.Content>
              )}
              {serviceCapabilities().dataWrites && (
                <Tabs.Content value="biomes">
                  <BiomesPanel session={session} />
                </Tabs.Content>
              )}
              {serviceCapabilities().users && (
                <Tabs.Content value="users">
                  <UsersPanel session={session} />
                </Tabs.Content>
              )}
            </Box>
          </Tabs.Root>
        )}
      </Container>
    </Theme>
  );
}
