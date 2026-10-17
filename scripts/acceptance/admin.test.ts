import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createApp } from '../../packages/server/src/app.js';
import { createServices } from '../../packages/server/src/services.js';
import { loadServerConfig } from '../../packages/server/src/configuration.js';
import { connectDatabase } from '../../packages/server/src/db/connection.js';
import { migrateDatabase } from '../../packages/server/src/db/migrations.js';
import { closeServer, project, serverOrigin, startStaticSite } from './helpers/frontend.js';

test(
  'admin session identity/logout, expired credentials, recoverable actions and confirmation dialogs',
  { timeout: 45_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-admin-browser-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = loadServerConfig({
      env: {
        DATA_DIR: root,
        WORLDS_DIR: path.join(root, 'worlds'),
        ROOT_USERNAME: 'operator',
        ROOT_PASSWORD: 'browser-root-password',
        CACHE_PREWARM: 'false',
      },
      cwd: root,
    });
    const maintenance = await connectDatabase({ databaseDir: config.database.dir });
    try {
      await migrateDatabase(maintenance);
    } finally {
      await maintenance.close();
    }
    const services = await createServices(config);
    t.after(() => services.close());
    const app = createApp(config, services);
    const api = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(/^\/violet(?=\/)/, '');
        return app.fetch(new Request(url, request));
      },
    });
    t.after(() => closeServer(api));
    const apiBase = `${await serverOrigin(api)}/violet/`;
    const base = (await fs.readFile(path.join(project, 'packages/admin/dist/index.html'), 'utf8')).includes(
      '/console/assets/',
    )
      ? '/console/'
      : '/';
    const site = await startStaticSite(root, 'admin', base, apiBase);
    t.after(() => {
      site.child.kill('SIGTERM');
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: 'en-US' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(site.url);
    const signIn = async () => {
      await page.locator('#login-username').fill('operator');
      await page.locator('#login-password').fill('browser-root-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForFunction(() => (document.querySelector('#admin-token') as HTMLInputElement)?.value.length > 0);
      assert.equal(await page.locator('#login-password').inputValue(), '');
    };
    await signIn();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Check session' }).waitFor();
    assert.match(await page.getByRole('menu').innerText(), /operator.*root/s);
    await page.keyboard.press('Escape');
    await page.locator('#new-world').fill('admin-dialog');
    const createRoute = '**/api/admin/worlds';
    await page.route(createRoute, (route) =>
      route.fulfill({ status: 503, contentType: 'text/html', body: 'upstream offline' }),
    );
    await page.getByRole('button', { name: 'Create empty world' }).click();
    await page.getByText('HTTP 503', { exact: true }).waitFor();
    await page.unroute(createRoute);
    await page.getByRole('button', { name: 'Create empty world' }).click();
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'admin-dialog', exact: true }) });
    await row.waitFor();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    await row.waitFor();
    assert.equal(await row.count(), 1);
    assert.ok(await services.mounts.worlds.stat('admin-dialog/level.dat'));
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    const deleteRoute = '**/api/admin/worlds/admin-dialog';
    await page.route(deleteRoute, (route) =>
      route.fulfill({ status: 503, contentType: 'text/html', body: 'upstream offline' }),
    );
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete permanently' }).click();
    await page.getByRole('alertdialog').getByText('HTTP 503', { exact: true }).waitFor();
    await page.unroute(deleteRoute);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete permanently' }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    await row.waitFor({ state: 'hidden' });
    const oldToken = await page.locator('#admin-token').inputValue();
    await services.users!.revokeCredential(oldToken);
    await page.getByRole('tab', { name: 'Users', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#admin-token') as HTMLInputElement)?.value === '');
    assert.equal(await page.getByRole('tab', { name: 'Worlds', exact: true }).getAttribute('aria-selected'), 'true');
    await signIn();
    const token = await page.locator('#admin-token').inputValue();
    await page.getByRole('button', { name: 'Account menu' }).click();
    const loggedOut = page.waitForResponse((response) => response.url().endsWith('/api/auth/logout') && response.ok());
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#admin-token') as HTMLInputElement)?.value === '');
    await page.getByRole('button', { name: 'Account menu' }).waitFor({ state: 'visible' });
    await loggedOut;
    assert.equal(await services.users!.authenticateCredential(token), undefined);
    assert.deepEqual(errors, []);
  },
);
