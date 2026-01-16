import { test, expect } from '@playwright/test';

test.setTimeout(90000);

test('HBS settings panel is injected', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => {
        pageErrors.push(error.message || String(error));
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            pageErrors.push(msg.text());
        }
    });
    page.on('requestfailed', (request) => {
        pageErrors.push(`${request.url()} -> ${request.failure()?.errorText || 'request failed'}`);
    });

    await page.goto('/');

    const onboardingDialog = page.locator('dialog.popup:has-text("Welcome to SillyTavern")');
    if (await onboardingDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
        await onboardingDialog.locator('.popup-input').fill('Test User');
        await onboardingDialog.locator('.popup-button-ok').click();
        await onboardingDialog.waitFor({ state: 'hidden', timeout: 15000 });
    }

    const interceptorReady = await page
        .waitForFunction(() => typeof window.hbs_generate_interceptor === 'function', null, { timeout: 60000 })
        .then(() => true)
        .catch(() => false);

    if (!interceptorReady) {
        throw new Error(`HBS interceptor not found. Page errors:\n${pageErrors.join('\n')}`);
    }

    const settingsPanel = page.locator('#hbs_settings');
    await expect(settingsPanel).toHaveCount(1);
    await expect(settingsPanel).toContainText('HBS - Hierarchical Bucket Summarizer');
    const profileSelect = page.locator('#hbs_profile_select');
    await expect(profileSelect).toHaveCount(1);

    const optionCount = await profileSelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(0);

    await expect(page.locator('#hbs_profile_status')).toHaveCount(1);
});
