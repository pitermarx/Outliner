import { test, expect, type Page } from './test';

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
          getClientExtensionResults: () => ({
            prf: {
              enabled: true,
              results: {
                first: prfOutput
              }
            }
          })
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

const installPrfRegistrationFailureStubs = async (page: Page) => {
  await page.addInitScript(() => {
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
          rawId: new Uint8Array([9, 9, 9, 9]).buffer,
          getClientExtensionResults: () => ({ prf: { enabled: false } })
        })
      });
    }
  });
};

const installMockSupabase = async (page: Page, options?: {
  userEmail?: string;
  authErrorMessage?: string;
  downloadData?: { salt: string; data: string; updated_at?: string } | null;
}) => {
  await page.evaluate(({ userEmail, authErrorMessage, downloadData }) => {
    const initialServerRecord = downloadData
      ? {
        salt: downloadData.salt,
        data: downloadData.data,
        updated_at: downloadData.updated_at || new Date().toISOString()
      }
      : null;

    (window as any).__mockSupabaseState = {
      serverRecord: initialServerRecord
    };

    const sessionState = {
      user: userEmail ? { id: 'user-1', email: userEmail } : null as any
    };

    const queryBuilder = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      single: async () => (window as any).__mockSupabaseState.serverRecord
        ? { data: (window as any).__mockSupabaseState.serverRecord, error: null }
        : { data: null, error: { code: 'PGRST116' } },
      upsert: async (payload: { salt: string; data: string; updated_at: string }) => {
        (window as any).__mockSupabaseState.serverRecord = {
          salt: payload.salt,
          data: payload.data,
          updated_at: payload.updated_at
        };
        return { error: null };
      }
    };

    const client = {
      auth: {
        signInWithPassword: async ({ email }: { email: string }) => {
          if (authErrorMessage) return { data: { user: null }, error: { message: authErrorMessage } };
          sessionState.user = { id: 'user-1', email };
          return { data: { user: sessionState.user }, error: null };
        },
        signUp: async ({ email }: { email: string }) => {
          if (authErrorMessage) return { data: { user: null }, error: { message: authErrorMessage } };
          sessionState.user = { id: 'user-1', email };
          return { data: { user: sessionState.user }, error: null };
        },
        signOut: async () => {
          sessionState.user = null;
          return { error: null };
        },
        getUser: async () => ({ data: { user: sessionState.user }, error: null })
      },
      from: () => queryBuilder
    };

    (window as any).supabase = {
      createClient: () => client
    };

    localStorage.setItem('supabaseconfig', JSON.stringify({
      url: 'http://127.0.0.1:54321',
      key: 'anon'
    }));

    (window as any).App.sync.init();
    (window as any).App.sync.refreshSession();
  }, options ?? {});
};

test.describe('Authentication', () => {
  test('first run flow: set passphrase', async ({ page }) => {
    // Clear localStorage to simulate first run
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');

    // Check for "Set Passphrase" screen
    await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    await expect(page.getByLabel('Create a passphrase')).toBeVisible();

    // Fill passphrase
    await page.getByLabel('Create a passphrase').fill('correct-horse');
    await page.getByRole('button', { name: 'Unlock' }).click();

    // Check for main app
    await expect(page.getByText('Hello World')).toBeVisible();

    // Verify data is stored encrypted
    const vmdData = await page.evaluate(() => localStorage.getItem('vmd_data'));
    expect(vmdData).toBeTruthy();
    expect(vmdData).not.toContain('Hello World'); // Should be encrypted
  });

  test('remote mode requires username password and passphrase before unlock', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');

    await page.getByRole('button', { name: 'Remote' }).click();

    const unlockButton = page.getByRole('button', { name: 'Unlock' });
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Username').fill('user@virgulas.com');
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Password').fill('account-password');
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Passphrase').fill('doc-passphrase');
    await expect(unlockButton).toBeEnabled();
  });

  test('second load with local encrypted data warns before switching to remote', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = (window as any).App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await (window as any).App.crypto.deriveKey('password', salt);
      const doc = { id: 'root', text: 'Secret Doc', children: [] };
      const encrypted = await (window as any).App.crypto.encrypt(JSON.stringify(doc), key);
      localStorage.setItem('vmd_data', encrypted);
    });

    await page.reload();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Remote' }).click();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');

    const stillHasData = await page.evaluate(() => !!localStorage.getItem('vmd_data'));
    expect(stillHasData).toBe(true);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Remote' }).click();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Remote');

    const clearedData = await page.evaluate(() => localStorage.getItem('vmd_data'));
    expect(clearedData).toBeNull();
  });

  test('stale session preselects remote and prefills username only', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_username', 'stale@virgulas.com');
    });
    await page.goto('/');

    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Remote');
    await expect(page.getByLabel('Username')).toHaveValue('stale@virgulas.com');

    const unlockButton = page.getByRole('button', { name: 'Unlock' });
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Password').fill('account-password');
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Passphrase').fill('doc-passphrase');
    await expect(unlockButton).toBeEnabled();
  });

  test('first load can sign in before passphrase creation and switch to unlock for synced data', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await page.evaluate(async () => {
      const salt = (window as any).App.crypto.generateSalt();
      const key = await (window as any).App.crypto.deriveKey('remote-passphrase', salt);
      const doc = {
        id: 'root',
        text: 'Remote Root',
        children: [
          { id: 'child-1', text: 'Remote Child', children: [] }
        ]
      };

      const data = await (window as any).App.crypto.encrypt(JSON.stringify(doc), key);
      return {
        salt,
        data
      };
    });

    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await installMockSupabase(page, { downloadData: remoteDoc });

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Username').fill('existing@virgulas.com');
    await page.getByLabel('Password').fill('account-password');
    await page.getByLabel('Passphrase').fill('remote-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    const storedSalt = await page.evaluate(() => localStorage.getItem('vmd_salt'));
    expect(storedSalt).toBe(remoteDoc.salt);

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.getByText('Remote Child')).toBeVisible();
  });

  test('valid remote session preselects remote and only needs passphrase to unlock', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await page.evaluate(async () => {
      const salt = (window as any).App.crypto.generateSalt();
      const key = await (window as any).App.crypto.deriveKey('remote-passphrase', salt);
      const doc = {
        id: 'root',
        text: 'Remote Root',
        children: [{ id: 'remote-1', text: 'From Server', children: [] }]
      };
      const data = await (window as any).App.crypto.encrypt(JSON.stringify(doc), key);
      return { salt, data };
    });

    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.evaluate((payload) => {
      (window as any).App.state.authMode.value = 'remote';
      (window as any).App.state.authScenario.value = 'remote-session-valid';
      (window as any).App.state.authRemotePayload.value = payload;
      (window as any).App.state.user.value = { id: 'user-1', email: 'valid@virgulas.com' };
      (window as any).App.storage.setSalt(payload.salt);
    }, remoteDoc);

    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Remote');
    await expect(page.getByLabel('Username')).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expect(page.getByLabel('Passphrase')).toBeVisible();

    await page.getByLabel('Passphrase').fill('remote-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.getByText('From Server')).toBeVisible();
  });

  test('switching valid remote session to local signs out after confirmation', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await page.evaluate(async () => {
      const salt = (window as any).App.crypto.generateSalt();
      const key = await (window as any).App.crypto.deriveKey('remote-passphrase', salt);
      const doc = {
        id: 'root',
        text: 'Remote Root',
        children: [{ id: 'remote-2', text: 'Remote Data', children: [] }]
      };
      const data = await (window as any).App.crypto.encrypt(JSON.stringify(doc), key);
      return { salt, data };
    });

    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.evaluate((payload) => {
      (window as any).App.state.authMode.value = 'remote';
      (window as any).App.state.authScenario.value = 'remote-session-valid';
      (window as any).App.state.authRemotePayload.value = payload;
      (window as any).App.state.user.value = { id: 'user-1', email: 'valid@virgulas.com' };
      (window as any).App.storage.setSalt(payload.salt);
    }, remoteDoc);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Local' }).click();

    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');
    await expect(page.getByLabel('Create a passphrase')).toBeVisible();

    const stateAfterSwitch = await page.evaluate(() => ({
      hasLocalData: !!localStorage.getItem('vmd_data'),
      user: (window as any).App.state.user.value
    }));

    expect(stateAfterSwitch.hasLocalData).toBe(false);
    expect(stateAfterSwitch.user).toBeNull();
  });

  test('quick unlock offer appears after passphrase unlock and Not now is session-only', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Quick unlock PRF coverage is Chromium-only');
    await installPrfStubs(page);

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.getByLabel(/passphrase/i).fill('session-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();
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

    await page.getByLabel(/passphrase/i).fill('quick-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();
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
    await expect(page.getByLabel('Passphrase')).toHaveCount(0);

    const status = await page.evaluate(() => (window as any).App.state.status.value);
    expect(status).toBe('ready');
  });

  test('failed quick unlock registration disables future offers on this profile', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Quick unlock PRF coverage is Chromium-only');
    await installPrfRegistrationFailureStubs(page);

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.getByLabel(/passphrase/i).fill('disabled-flag-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    await page.reload();
    await page.getByLabel('Passphrase').fill('disabled-flag-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.getByText('Enable quick unlock on this device?')).toBeVisible();
    await page.getByRole('button', { name: 'Enable quick unlock' }).click();
    await expect(page.getByText('Enable quick unlock on this device?')).toBeHidden();

    const disabledFlag = await page.evaluate(() => localStorage.getItem('vmd_prf_disabled'));
    expect(disabledFlag).toBe('1');

    await page.reload();
    await page.getByLabel('Passphrase').fill('disabled-flag-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('Enable quick unlock on this device?')).toBeHidden();
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
    await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible();
    await expect(page.getByLabel('Passphrase')).toBeVisible();
    await expect(page.getByLabel('Create a passphrase')).toHaveCount(0);

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

  test('login screen can sign up with mocked sync', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await installMockSupabase(page);

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Username').fill('mock-signup@virgulas.com');
    await page.getByLabel('Password').fill('mock-password');
    await page.getByLabel('Passphrase').fill('signup-passphrase');
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.getByRole('button', { name: 'Unlock' })).toBeEnabled();
  });

  test('login screen shows auth provider errors in remote mode', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await installMockSupabase(page, { authErrorMessage: 'Invalid login credentials' });

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Username').fill('mock-error@virgulas.com');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByLabel('Passphrase').fill('doc-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.getByText('Invalid login credentials')).toBeVisible();
  });

  test('login screen can reset quick unlock local keys and disable flag', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      localStorage.clear();
      const salt = (window as any).App.crypto.generateSalt();
      localStorage.setItem('vmd_salt', salt);
      const key = await (window as any).App.crypto.deriveKey('reset-quick-unlock-passphrase', salt);
      const doc = { id: 'root', text: 'Doc', children: [] };
      const encrypted = await (window as any).App.crypto.encrypt(JSON.stringify(doc), key);
      localStorage.setItem('vmd_data', encrypted);
      localStorage.setItem('vmd_prf_wrapped', 'wrapped-value');
      localStorage.setItem('vmd_prf_id', 'cred-id');
      localStorage.setItem('vmd_prf_disabled', '1');
      localStorage.setItem('vmd_prf_disabled_reason', 'unlock_failed');
    });

    await page.reload();
    await expect(page.getByRole('button', { name: 'Reset Quick Unlock Keys' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset Quick Unlock Keys' }).click();

    const quickUnlockValues = await page.evaluate(() => ({
      wrapped: localStorage.getItem('vmd_prf_wrapped'),
      id: localStorage.getItem('vmd_prf_id'),
      disabled: localStorage.getItem('vmd_prf_disabled'),
      reason: localStorage.getItem('vmd_prf_disabled_reason')
    }));

    expect(quickUnlockValues.wrapped).toBeNull();
    expect(quickUnlockValues.id).toBeNull();
    expect(quickUnlockValues.disabled).toBeNull();
    expect(quickUnlockValues.reason).toBeNull();
  });

  test('remote decrypt failure offers reset with new passphrase', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await page.evaluate(async () => {
      const salt = (window as any).App.crypto.generateSalt();
      const key = await (window as any).App.crypto.deriveKey('old-passphrase', salt);
      const doc = { id: 'root', text: 'Legacy Remote', children: [] };
      const data = await (window as any).App.crypto.encrypt(JSON.stringify(doc), key);
      return { salt, data };
    });

    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await installMockSupabase(page, { downloadData: remoteDoc });

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Username').fill('recover@virgulas.com');
    await page.getByLabel('Password').fill('mock-password');
    await page.getByLabel('Passphrase').fill('new-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.getByText('Authenticated, but data could not be decrypted with this passphrase. You can reset remote data with a new passphrase.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset Remote Data With New Passphrase' })).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Reset Remote Data With New Passphrase' }).click();

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.getByText('Hello World')).toBeVisible();
  });

});
