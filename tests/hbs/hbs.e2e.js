import { test, expect } from '@playwright/test';

test('HBS settings panel is injected', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.hbs_generate_interceptor === 'function');

    const settingsPanel = page.locator('#hbs_settings');
    await expect(settingsPanel).toHaveCount(1);
    await expect(settingsPanel).toContainText('HBS - Hierarchical Bucket Summarizer');
    const profileSelect = page.locator('#hbs_profile_select');
    await expect(profileSelect).toHaveCount(1);

    const optionCount = await profileSelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(0);

    await expect(page.locator('#hbs_profile_status')).toHaveCount(1);
});
