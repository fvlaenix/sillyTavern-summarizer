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

async function openSillyTavern(page, pageErrors) {
    await page.goto('/');
    await dismissOnboarding(page);
    await ensureHbsReady(page, pageErrors);
}

async function mockTextGeneration(page, responseText = 'Mock AI reply') {
    await page.route('**/api/**/generate', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                results: [{ text: responseText }],
                choices: [{ text: responseText, message: { content: responseText } }],
                output: responseText,
                text: responseText,
                content: [{ type: 'text', text: responseText }],
            }),
        });
    });
}

async function setupHbsTestContext(page, {
    mainApi = 'kobold',
    summaryText = 'Mock HBS summary',
    profileId = 'hbs-test-profile',
    base = 2,
    keepLastN = 1,
    maxSummaryWords = 20,
} = {}) {
    await page.evaluate(async (config) => {
        const script = await import('/script.js');
        let context = window.SillyTavern.getContext();
        const apiSelect = document.querySelector('#main_api');
        if (apiSelect) {
            apiSelect.value = config.mainApi;
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
            return { content: config.summaryText };
        };

        context.extensionSettings.hbs = context.extensionSettings.hbs || {};
        Object.assign(context.extensionSettings.hbs, {
            enabledGlobally: true,
            selectedProfileId: config.profileId,
            defaultBase: config.base,
            defaultKeepLastN: config.keepLastN,
            defaultMaxSummaryWords: config.maxSummaryWords,
        });

        context.chatMetadata.hbs = {
            version: 1,
            enabled: true,
            base: config.base,
            keepLastN: config.keepLastN,
            maxSummaryWords: config.maxSummaryWords,
            processedUntil: 0,
            buckets: [],
            dirty: false,
            fingerprint: '',
        };
    }, {
        mainApi,
        summaryText,
        profileId,
        base,
        keepLastN,
        maxSummaryWords,
    });
}

async function sendUserMessage(page, text) {
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
}

async function waitForUserMessage(page, text) {
    await page.waitForFunction((message) => {
        const chat = window.SillyTavern.getContext().chat || [];
        return chat.some((msg) => msg && msg.is_user === true && (msg.mes || '').includes(message));
    }, text);
}

async function waitForAiReply(page, text) {
    await page.waitForFunction((message) => {
        const chat = window.SillyTavern.getContext().chat || [];
        return chat.some((msg) => msg && msg.is_user === false && (msg.mes || '').includes(message));
    }, text);
}

async function getAiReplyCount(page, text) {
    return page.evaluate((message) => {
        const chat = window.SillyTavern.getContext().chat || [];
        return chat.filter((msg) => msg && msg.is_user === false && (msg.mes || '').includes(message)).length;
    }, text);
}

async function waitForAiReplyCount(page, text, minCount) {
    await page.waitForFunction((message, expected) => {
        const chat = window.SillyTavern.getContext().chat || [];
        const count = chat.filter((msg) => msg && msg.is_user === false && (msg.mes || '').includes(message)).length;
        return count >= expected;
    }, text, minCount);
}

async function waitForBucketCount(page, count, timeout = 20000) {
    return page
        .waitForFunction((expected) => {
            const buckets = window.SillyTavern.getContext().chatMetadata?.hbs?.buckets || [];
            return buckets.length === expected;
        }, count, { timeout })
        .then(() => true)
        .catch(() => false);
}

async function getHbsDebugState(page) {
    return page.evaluate(() => {
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
}

async function assertBucketCount(page, count, timeout = 20000) {
    const ready = await waitForBucketCount(page, count, timeout);
    if (!ready) {
        const debugState = await getHbsDebugState(page);
        throw new Error(`HBS buckets not created: ${JSON.stringify(debugState)}`);
    }
}

async function getBucketSummary(page, index = 0) {
    return page.evaluate((bucketIndex) => {
        return window.SillyTavern.getContext().chatMetadata.hbs.buckets[bucketIndex].summary;
    }, index);
}

async function getSummaryCalls(page) {
    return page.evaluate(() => window.__hbsSummaryCalls || 0);
}

test('HBS settings panel is injected', async ({ page }) => {
    const pageErrors = attachPageErrorHandlers(page);

    await openSillyTavern(page, pageErrors);

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

    await openSillyTavern(page, pageErrors);
    await mockTextGeneration(page);
    await setupHbsTestContext(page);

    await page.waitForSelector('#send_textarea');

    await sendUserMessage(page, 'Hello from user 1');
    await waitForUserMessage(page, 'Hello from user 1');
    await waitForAiReply(page, 'Mock AI reply');

    const firstReplyCount = await getAiReplyCount(page, 'Mock AI reply');

    await sendUserMessage(page, 'Hello from user 2');
    await waitForUserMessage(page, 'Hello from user 2');
    await waitForAiReplyCount(page, 'Mock AI reply', firstReplyCount + 1);

    await assertBucketCount(page, 1);

    const summaryText = await getBucketSummary(page, 0);
    expect(summaryText).toContain('Mock HBS summary');

    const summaryCalls = await getSummaryCalls(page);
    expect(summaryCalls).toBe(1);
});
