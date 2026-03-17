import { test, expect, type Page } from '@playwright/test';

const installPrfStubs = async (page: Page) => {
  await page.addInitScript(() => {
    const prfOutput = new Uint8Array(32);
    for (let i = 0; i < prfOutput.length; i++) prfOutput[i] = (i * 7) % 255;

    class MockPublicKeyCredential {
      static async getClientCapabilities() {
        return { prf: true };
      }
    }

    Object.defineProperty(window, 'PublicKeyCredential', {
      configurable: true,
      writable: true,
      value: MockPublicKeyCredential
    });

    if (navigator.credentials) {
      Object.defineProperty(navigator.credentials, 'create', {
        configurable: true,
        writable: true,
        value: async () => ({
          rawId: new Uint8Array([1, 2, 3, 4]).buffer,
          getClientExtensionResults: () => ({ prf: { enabled: true } })
        })
      });

      Object.defineProperty(navigator.credentials, 'get', {
        configurable: true,
        writable: true,
        value: async () => ({
          getClientExtensionResults: () => ({
            prf: {
              results: {
                first: prfOutput
              }
            }
          })
        })
      });
    }
  });
};

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log(`[Browser Console] ${msg.text()}`));
    page.on('pageerror', err => console.log(`[Browser Error] ${err.toString()}`));
  });

  test('first run flow: set passphrase', async ({ page }) => {
    // Clear localStorage to simulate first run
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');

    // Check for "Set Passphrase" screen
    await expect(page.getByRole('heading', { name: /Welcome/i })).toBeVisible();
    await expect(page.getByLabel('Create Passphrase')).toBeVisible();
    await expect(page.getByLabel('Confirm Passphrase')).toBeVisible();

    // Fill passphrase
    await page.getByLabel('Create Passphrase').fill('correct-horse');
    await page.getByLabel('Confirm Passphrase').fill('correct-horse');
    await page.getByRole('button', { name: 'Start Writing' }).click();

    // Check for main app
    await expect(page.getByText('Hello World')).toBeVisible();

    // Verify data is stored encrypted
    const vmdData = await page.evaluate(() => localStorage.getItem('vmd_data'));
    expect(vmdData).toBeTruthy();
    expect(vmdData).not.toContain('Hello World'); // Should be encrypted
  });

  test('quick unlock offer appears after passphrase unlock and Not now is session-only', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Quick unlock PRF coverage is Chromium-only');
    await installPrfStubs(page);

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.getByLabel('Create Passphrase').fill('session-passphrase');
    await page.getByLabel('Confirm Passphrase').fill('session-passphrase');
    await page.getByRole('button', { name: 'Start Writing' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    await page.reload();
    await page.getByLabel('Passphrase').fill('session-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.getByText('Enable quick unlock on this device?')).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByText('Enable quick unlock on this device?')).toBeHidden();

    await page.reload();
    await page.getByLabel('Passphrase').fill('session-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('Enable quick unlock on this device?')).toBeVisible();
  });

  test('can enable quick unlock and auto-unlock on reload', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Quick unlock PRF coverage is Chromium-only');
    await installPrfStubs(page);

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.getByLabel('Create Passphrase').fill('quick-passphrase');
    await page.getByLabel('Confirm Passphrase').fill('quick-passphrase');
    await page.getByRole('button', { name: 'Start Writing' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    await page.reload();
    await page.getByLabel('Passphrase').fill('quick-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.getByText('Enable quick unlock on this device?')).toBeVisible();
    await page.getByRole('button', { name: 'Enable quick unlock' }).click();
    await expect(page.getByText('Enable quick unlock on this device?')).toBeHidden();

    const hasQuickUnlockData = await page.evaluate(() => {
      return !!localStorage.getItem('vmd_prf_wrapped') && !!localStorage.getItem('vmd_prf_id');
    });
    expect(hasQuickUnlockData).toBe(true);

    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.getByLabel('Passphrase')).toBeHidden();

    const status = await page.evaluate(() => (window as any).App.state.status.value);
    expect(status).toBe('ready');
  });

  test('unlock flow: existing user', async ({ page }) => {
    // Seed localStorage with encrypted data (using a known password 'password')
    // We can use the app's crypto functions to create valid data
    await page.goto('/'); // Load page to get crypto available

    await page.evaluate(async () => {
      // Clear storage first
      localStorage.clear();

      // Manually set up state as if user had already set password 'password'
      const salt = (window as any).App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);

      const key = await (window as any).App.crypto.deriveKey('password', salt);

      const doc = {
        id: 'root',
        text: 'Secret Doc',
        children: []
      };

      const encrypted = await (window as any).App.crypto.encrypt(JSON.stringify(doc), key);
      localStorage.setItem('vmd_data', encrypted);
    });

    await page.reload();

    // Check for "Unlock" screen
    await expect(page.getByRole('heading', { name: /Welcome Back/i })).toBeVisible();
    await expect(page.getByLabel('Passphrase')).toBeVisible();
    await expect(page.getByLabel('Confirm Passphrase')).toBeHidden(); // Confirm should be hidden

    // Enter WRONG password
    await page.getByLabel('Passphrase').fill('wrong-password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText(/Invalid passphrase/i)).toBeVisible();

    // Enter CORRECT password
    await page.getByLabel('Passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();

    // Wait for main view to render
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Verify internal state has the document (title is not rendered as a heading)
    const doc = await page.evaluate(() => (window as any).App.state.doc.value);
    expect(doc.text).toBe('Secret Doc');
  });
});
