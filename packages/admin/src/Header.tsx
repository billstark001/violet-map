import { useState } from 'react';
import { Badge, Box, Button, Callout, DropdownMenu, Flex, Heading, Select, Text, TextField } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { languageOptions } from './i18n';
import { serviceCapabilities } from './runtime';
import { localStorageOrNull } from './useSession';
import type { AdminSession, SessionState } from './session';

export function Header({ session, state }: { session: AdminSession; state: SessionState }) {
  const { t, i18n } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const signIn = async () => {
    if (await session.signIn(username, password)) setPassword('');
  };
  const changeLanguage = (value: string) => {
    void i18n.changeLanguage(value);
    try {
      localStorageOrNull()?.setItem('violet-map:language', value);
    } catch {
      /* restricted storage */
    }
  };
  return (
    <>
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
                  value={username}
                  onChange={(e) => setUsername(e.currentTarget.value)}
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
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && username && password && !state.busy) {
                      e.preventDefault();
                      void signIn();
                    }
                  }}
                />
              </Box>
              <Button variant="soft" onClick={() => void signIn()} disabled={!username || !password || state.busy}>
                {t('signIn')}
              </Button>
            </>
          )}
          {serviceCapabilities().authMode !== 'none' && (
            <>
              <Box style={{ width: 220 }}>
                <Text as="label" size="1" htmlFor="admin-token">
                  {t('token')}
                </Text>
                <TextField.Root
                  id="admin-token"
                  type="password"
                  autoComplete="off"
                  value={state.token}
                  onChange={(e) => session.setToken(e.currentTarget.value)}
                />
              </Box>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Button variant="soft" aria-label={t('accountMenu')} disabled={state.busy}>
                    {state.user?.username ?? t('credential')}
                    <DropdownMenu.TriggerIcon />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  <DropdownMenu.Label>
                    {state.user ? (
                      <>
                        {state.user.username} <Badge>{state.user.role}</Badge>
                      </>
                    ) : state.token ? (
                      t('credentialPresent')
                    ) : (
                      t('signedOut')
                    )}
                  </DropdownMenu.Label>
                  {serviceCapabilities().authMode === 'users' && (
                    <DropdownMenu.Item disabled={!state.token} onSelect={() => void session.refresh()}>
                      {t('checkSession')}
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item
                    color="red"
                    disabled={!state.token}
                    onSelect={() => {
                      setPassword('');
                      void session.signOut();
                    }}
                  >
                    {t('signOut')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </>
          )}
          <Box style={{ width: 160 }}>
            <Text as="label" size="1" htmlFor="admin-language">
              {t('language')}
            </Text>
            <Select.Root value={i18n.resolvedLanguage ?? i18n.language} onValueChange={changeLanguage}>
              <Select.Trigger id="admin-language" />
              <Select.Content>
                {languageOptions.map((language) => (
                  <Select.Item key={language.value} value={language.value}>
                    {language.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>
        </Flex>
      </Flex>
      {state.error && (
        <Callout.Root mb="3" color="red" role="alert">
          <Callout.Text>{state.error}</Callout.Text>
        </Callout.Root>
      )}
    </>
  );
}
