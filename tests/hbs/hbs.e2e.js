import { test, expect } from '@playwright/test';

test.setTimeout(90000);

function attachPageErrorHandlers(page) {
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
    return pageErrors;
}

async function dismissOnboarding(page) {
    const onboardingDialog = page.locator('dialog:has-text("Welcome to SillyTavern")');
    const dialogVisible = await onboardingDialog
        .waitFor({ state: 'visible', timeout: 15000 })
        .then(() => true)
        .catch(() => false);

    if (dialogVisible) {
        const input = onboardingDialog.locator('input.popup-input, input[type="text"]').first();
        if (await input.count()) {
            await input.fill('Test User');
        }
        const primarySave = onboardingDialog.locator('.popup-button-ok');
        if (await primarySave.count()) {
            await primarySave.first().click();
        } else {
            const textSave = onboardingDialog.getByText('Save', { exact: true });
            if (await textSave.count()) {
                await textSave.first().click();
            }
        }
        await onboardingDialog.waitFor({ state: 'hidden', timeout: 15000 });
    }
}

async function ensureHbsReady(page, pageErrors) {
    const interceptorReady = await page
        .waitForFunction(() => typeof window.hbs_generate_interceptor === 'function', null, { timeout: 60000 })
        .then(() => true)
        .catch(() => false);

    if (!interceptorReady) {
        throw new Error(`HBS interceptor not found. Page errors:\n${pageErrors.join('\n')}`);
    }
}

test('HBS settings panel is injected', async ({ page }) => {
    const pageErrors = attachPageErrorHandlers(page);

    await page.goto('/');

    await dismissOnboarding(page);
    await ensureHbsReady(page, pageErrors);

    const settingsPanel = page.locator('#hbs_settings');
    await expect(settingsPanel).toHaveCount(1);
    await expect(settingsPanel).toContainText('HBS - Hierarchical Bucket Summarizer');
    const profileSelect = page.locator('#hbs_profile_select');
    await expect(profileSelect).toHaveCount(1);

    const optionCount = await profileSelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(0);

    await expect(page.locator('#hbs_profile_status')).toHaveCount(1);
});

test('HBS summarizes older messages during chat', async ({ page }) => {
    const pageErrors = attachPageErrorHandlers(page);

    await page.goto('/');
    await dismissOnboarding(page);
    await ensureHbsReady(page, pageErrors);

    await page.route('**/api/**/generate', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                results: [{ text: 'Mock AI reply' }],
                choices: [{ text: 'Mock AI reply', message: { content: 'Mock AI reply' } }],
                output: 'Mock AI reply',
                text: 'Mock AI reply',
                content: [{ type: 'text', text: 'Mock AI reply' }],
            }),
        });
    });

    await page.evaluate(async () => {
        const script = await import('/script.js');
        let context = window.SillyTavern.getContext();
        const apiSelect = document.querySelector('#main_api');
        if (apiSelect) {
            apiSelect.value = 'kobold';
            apiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        script.setOnlineStatus('connected');
        await context.getCharacters();
        if (!context.characters?.length) {
            throw new Error('No characters loaded');
        }
        await context.selectCharacterById(0);

        context = window.SillyTavern.getContext();
        window.__hbsSummaryCalls = 0;
        window.__hbsInterceptorCalls = 0;

        const originalInterceptor = window.hbs_generate_interceptor;
        if (typeof originalInterceptor === 'function') {
            window.hbs_generate_interceptor = async (...args) => {
                window.__hbsInterceptorCalls += 1;
                return await originalInterceptor(...args);
            };
        }

        context.ConnectionManagerRequestService.sendRequest = async () => {
            window.__hbsSummaryCalls += 1;
            return { content: 'Mock HBS summary' };
        };

        context.extensionSettings.hbs = context.extensionSettings.hbs || {};
        Object.assign(context.extensionSettings.hbs, {
            enabledGlobally: true,
            selectedProfileId: 'hbs-test-profile',
            defaultBase: 2,
            defaultKeepLastN: 1,
            defaultMaxSummaryWords: 20,
        });

        context.chatMetadata.hbs = {
            version: 1,
            enabled: true,
            base: 2,
            keepLastN: 1,
            maxSummaryWords: 20,
            processedUntil: 0,
            buckets: [],
            dirty: false,
            fingerprint: '',
        };
    });

    await page.waitForSelector('#send_textarea');

    const sendMessage = async (text) => {
        await page.evaluate(async (value) => {
            const script = await import('/script.js');
            script.setOnlineStatus('connected');
            const textarea = document.querySelector('#send_textarea');
            if (!textarea) {
                throw new Error('send_textarea not found');
            }
            textarea.value = value;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            await script.sendTextareaMessage();
        }, text);
    };

    await sendMessage('Hello from user 1');
    await page.waitForFunction(() => {
        const chat = window.SillyTavern.getContext().chat || [];
        return chat.some((msg) => msg && msg.is_user === true && (msg.mes || '').includes('Hello from user 1'));
    });
    await page.waitForFunction(() => {
        const chat = window.SillyTavern.getContext().chat || [];
        return chat.some((msg) => msg && msg.is_user === false && (msg.mes || '').includes('Mock AI reply'));
    });

    const firstReplyCount = await page.evaluate(() => {
        const chat = window.SillyTavern.getContext().chat || [];
        return chat.filter((msg) => msg && msg.is_user === false && (msg.mes || '').includes('Mock AI reply')).length;
    });

    await sendMessage('Hello from user 2');
    await page.waitForFunction(() => {
        const chat = window.SillyTavern.getContext().chat || [];
        return chat.some((msg) => msg && msg.is_user === true && (msg.mes || '').includes('Hello from user 2'));
    });
    await page.waitForFunction((prevCount) => {
        const chat = window.SillyTavern.getContext().chat || [];
        const count = chat.filter((msg) => msg && msg.is_user === false && (msg.mes || '').includes('Mock AI reply')).length;
        return count >= prevCount + 1;
    }, firstReplyCount);

    const bucketReady = await page
        .waitForFunction(() => {
            const buckets = window.SillyTavern.getContext().chatMetadata?.hbs?.buckets || [];
            return buckets.length === 1;
        }, null, { timeout: 20000 })
        .then(() => true)
        .catch(() => false);

    if (!bucketReady) {
        const debugState = await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            return {
                mainApi: context.mainApi,
                onlineStatus: context.onlineStatus,
                chatLength: context.chat?.length || 0,
                lastMessage: context.chat?.[context.chat.length - 1]?.mes || null,
                hbsSettings: context.extensionSettings?.hbs || null,
                hbsState: context.chatMetadata?.hbs || null,
                summaryCalls: window.__hbsSummaryCalls || 0,
                interceptorCalls: window.__hbsInterceptorCalls || 0,
            };
        });
        throw new Error(`HBS buckets not created: ${JSON.stringify(debugState)}`);
    }

    const summaryText = await page.evaluate(() => {
        return window.SillyTavern.getContext().chatMetadata.hbs.buckets[0].summary;
    });
    expect(summaryText).toContain('Mock HBS summary');

    const summaryCalls = await page.evaluate(() => window.__hbsSummaryCalls);
    expect(summaryCalls).toBe(1);
});
