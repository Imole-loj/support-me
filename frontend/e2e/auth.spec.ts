import { test, expect } from '@playwright/test';
import {
  setupE2EMocks,
  setAuthenticatedSession,
  MOCK_USER_ADDRESS,
} from './fixtures/test-mocks';

test.describe('Authentication Flows', () => {
  test('user can connect wallet and sign in from landing page', async ({ page }) => {
    await setupE2EMocks(page);

    // 1. Visit the home page
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Connect Wallet' })).toBeVisible();

    // 2. Click "Connect Wallet" in the navigation bar
    await page.getByRole('button', { name: 'Connect Wallet' }).click();

    // 3. User with existing profile should be redirected to /app
    await page.waitForURL('**/app');
    await expect(page.getByRole('heading', { name: /Hey,/i })).toBeVisible();

    // 4. Verify wallet menu chip displays truncated address
    const truncatedAddress = `${MOCK_USER_ADDRESS.slice(0, 4)}…${MOCK_USER_ADDRESS.slice(-4)}`;
    const walletChip = page.getByRole('button', { name: new RegExp(truncatedAddress) });
    await expect(walletChip).toBeVisible();

    // 5. Verify user session is stored in localStorage while session token is held in httpOnly cookie (#366)
    const authUser = await page.evaluate(() => localStorage.getItem('authUser'));
    expect(authUser).toBeTruthy();
    const authToken = await page.evaluate(() => localStorage.getItem('authToken'));
    expect(authToken).toBeNull();
  });

  test('user can sign out using wallet menu', async ({ page }) => {
    await setupE2EMocks(page);
    await setAuthenticatedSession(page);

    // 1. Visit app hub as an authenticated user
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: /Hey,/i })).toBeVisible();

    // 2. Open wallet menu
    const truncatedAddress = `${MOCK_USER_ADDRESS.slice(0, 4)}…${MOCK_USER_ADDRESS.slice(-4)}`;
    const walletChip = page.getByRole('button', { name: new RegExp(truncatedAddress) });
    await walletChip.click();

    // 3. Click "Sign Out"
    const signOutBtn = page.getByRole('menuitem', { name: 'Sign Out' });
    await expect(signOutBtn).toBeVisible();
    await signOutBtn.click();

    // 4. Should redirect to landing page and show "Connect Wallet"
    await page.waitForURL('**/');
    await expect(page.getByRole('button', { name: 'Connect Wallet' })).toBeVisible();

    // 5. Verify localStorage tokens and session are cleared
    const token = await page.evaluate(() => localStorage.getItem('authToken'));
    expect(token).toBeNull();
    const user = await page.evaluate(() => localStorage.getItem('authUser'));
    expect(user).toBeNull();
  });

  test('protected route displays wallet connection barrier when unauthenticated', async ({ page }) => {
    await setupE2EMocks(page);

    // 1. Directly visit protected route without an auth session
    await page.goto('/app');

    // 2. ProtectedRoute renders barrier
    await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
    await expect(page.getByText('Connect your Stellar wallet, sign in with Twitter, or use a magic link.')).toBeVisible();

    // 3. Click "Connect Wallet" on the barrier
    await page.getByRole('button', { name: 'Connect Wallet' }).click();

    // 4. Once authenticated, protected content loads
    await expect(page.getByRole('heading', { name: /Hey,/i })).toBeVisible();
  });
});
