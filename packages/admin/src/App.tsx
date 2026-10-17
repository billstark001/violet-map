import { apiFetch, apiTokenKey, serviceCapabilities } from './runtime';
import { useState } from 'react';
import { Box, Button, Callout, Container, Flex, Heading, Select, Tabs, Text, TextField, Theme } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { languageOptions } from './i18n';
import { WorldsPanel } from './panels/WorldsPanel';
import { UploadPanel } from './panels/UploadPanel';
import { BiomesPanel } from './panels/BiomesPanel';
import { UsersPanel } from './panels/UsersPanel';

const adminTokenKey = () => apiTokenKey('admin-token');

export default function App() {
  const { t, i18n } = useTranslation();
  const [token, setToken] = useState(() => localStorage.getItem(adminTokenKey()) ?? '');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const changeToken = (value: string) => {
    setToken(value);
    try {
      localStorage.setItem(adminTokenKey(), value);
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
  const signIn = async () => {
    setLoginMessage(null);
    const res = await apiFetch('api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: loginUsername, password: loginPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.token !== 'string') {
      setLoginMessage(data.error ?? t('signInFailed'));
      return;
    }
    changeToken(data.token);
    setLoginPassword('');
  };
  return (
    <Theme appearance="dark" accentColor="violet">
      <Container size="3" py="5">
        <Flex justify="between" align="end" gap="3" mb="4" wrap="wrap">
          <Flex align="center" gap="3">
            <img src={`${import.meta.env.BASE_URL}brand/violet-map-logo-light.svg`} alt="" width="44" height="32" />
            <Heading>{t('title')}</Heading>
          </Flex>
          <Flex gap="2" align="end" wrap="wrap">
            {serviceCapabilities().authMode === 'users' && (
              <>
                <Box style={{ width: 150 }}>
                  <Text as="label" size="1" htmlFor="login-username">
                    {t('username')}
                  </Text>
                  <TextField.Root
                    id="login-username"
                    autoComplete="username"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.currentTarget.value)}
                  />
                </Box>
                <Box style={{ width: 150 }}>
                  <Text as="label" size="1" htmlFor="login-password">
                    {t('password')}
                  </Text>
                  <TextField.Root
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void signIn();
                    }}
                  />
                </Box>
                <Button variant="soft" onClick={() => void signIn()} disabled={!loginUsername || !loginPassword}>
                  {t('signIn')}
                </Button>
              </>
            )}
            {serviceCapabilities().authMode !== 'none' && (
              <Box style={{ width: 220 }}>
                <Text as="label" size="1" htmlFor="admin-token">
                  {t('token')}
                </Text>
                <TextField.Root
                  id="admin-token"
                  type="password"
                  value={token}
                  onChange={(e) => changeToken(e.currentTarget.value)}
                />
              </Box>
            )}
            <Box style={{ width: 160 }}>
              <Text as="label" size="1">
                {t('language')}
              </Text>
              <Select.Root value={i18n.resolvedLanguage ?? i18n.language} onValueChange={changeLanguage}>
                <Select.Trigger />
                <Select.Content>
                  {languageOptions.map((l) => (
                    <Select.Item key={l.value} value={l.value}>
                      {l.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Box>
          </Flex>
        </Flex>
        {loginMessage && (
          <Callout.Root mb="3" color="red">
            <Callout.Text>{loginMessage}</Callout.Text>
          </Callout.Root>
        )}
        {!serviceCapabilities().adminApi ? (
          <Callout.Root>
            <Callout.Text>This server has not enabled management features.</Callout.Text>
          </Callout.Root>
        ) : (
          <Tabs.Root defaultValue="worlds">
            <Tabs.List>
              <Tabs.Trigger value="worlds">{t('worlds')}</Tabs.Trigger>
              {serviceCapabilities().worldWrites && <Tabs.Trigger value="upload">{t('upload')}</Tabs.Trigger>}
              {serviceCapabilities().dataWrites && <Tabs.Trigger value="biomes">{t('biomes')}</Tabs.Trigger>}
              {serviceCapabilities().users && <Tabs.Trigger value="users">{t('users')}</Tabs.Trigger>}
            </Tabs.List>
            <Box mt="4">
              <Tabs.Content value="worlds">
                <WorldsPanel token={token} />
              </Tabs.Content>
              {serviceCapabilities().worldWrites && (
                <Tabs.Content value="upload">
                  <UploadPanel token={token} />
                </Tabs.Content>
              )}
              {serviceCapabilities().dataWrites && (
                <Tabs.Content value="biomes">
                  <BiomesPanel token={token} />
                </Tabs.Content>
              )}
              {serviceCapabilities().users && (
                <Tabs.Content value="users">
                  <UsersPanel token={token} />
                </Tabs.Content>
              )}
            </Box>
          </Tabs.Root>
        )}
      </Container>
    </Theme>
  );
}
