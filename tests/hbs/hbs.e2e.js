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

async function dismissIntegrityError(page) {
    const integrityDialog = page.locator('dialog:has-text("Chat integrity check failed")');
    const dialogVisible = await integrityDialog
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

    if (dialogVisible) {
        const input = integrityDialog.locator('input[type="text"], input.popup-input, textarea').first();
        if (await input.count()) {
            await input.fill('OVERWRITE');
        }
        const okButton = integrityDialog.getByText('OK', { exact: true });
        if (await okButton.count()) {
            await okButton.first().click();
        }
        await page.waitForLoadState('domcontentloaded');
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
    await dismissIntegrityError(page);
    await dismissOnboarding(page);
    await ensureHbsReady(page, pageErrors);
}

async function mockTextGeneration(page, responseText = 'Mock AI reply') {
    const responseQueue = Array.isArray(responseText) ? responseText.slice() : null;
    const defaultResponse = Array.isArray(responseText) && responseText.length
        ? responseText[responseText.length - 1]
        : responseText;

    await page.route('**/api/**/generate', async (route) => {
        const text = responseQueue && responseQueue.length
            ? responseQueue.shift()
            : (defaultResponse || 'Mock AI reply');
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                results: [{ text }],
                choices: [{ text, message: { content: text } }],
                output: text,
                text,
                content: [{ type: 'text', text }],
            }),
        });
    });
}

function extractPromptFromPayload(payload) {
    if (!payload) {
        return '';
    }
    if (typeof payload === 'string') {
        return payload;
    }
    if (payload.prompt) {
        return payload.prompt;
    }
    if (Array.isArray(payload.messages)) {
        return payload.messages.map((message) => message?.content || '').join('\n');
    }
    if (payload.text) {
        return payload.text;
    }
    return JSON.stringify(payload);
}

async function mockTextGenerationWithCapture(page, captureFn, responseText = 'Mock AI reply') {
    const responseQueue = Array.isArray(responseText) ? responseText.slice() : null;
    const defaultResponse = Array.isArray(responseText) && responseText.length
        ? responseText[responseText.length - 1]
        : responseText;

    await page.route('**/api/**/generate', async (route, request) => {
        const rawPayload = request.postData();
        let payload = null;
        try {
            payload = rawPayload ? JSON.parse(rawPayload) : null;
        } catch (error) {
            payload = rawPayload;
        }
        if (captureFn) {
            captureFn(payload);
        }

        const text = responseQueue && responseQueue.length
            ? responseQueue.shift()
            : (defaultResponse || 'Mock AI reply');
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                results: [{ text }],
                choices: [{ text, message: { content: text } }],
                output: text,
                text,
                content: [{ type: 'text', text }],
            }),
        });
    });
}

async function setupHbsTestContext(page, {
    mainApi = 'kobold',
    summaryText = 'Mock HBS summary',
    summaryMode = 'firstWord',
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
        if (typeof context.clearChat === 'function') {
            await context.clearChat();
        }
        if (Array.isArray(context.chat)) {
            context.chat.length = 0;
        }

        context = window.SillyTavern.getContext();
        window.__hbsSummaryCalls = 0;
        window.__hbsInterceptorCalls = 0;

        const originalInterceptor = window.hbs_generate_interceptor;
        if (typeof originalInterceptor === 'function') {
            window.hbs_generate_interceptor = async (...args) => {
                window.__hbsInterceptorCalls += 1;
                const result = await originalInterceptor(...args);
                const chatArg = args[0];
                if (Array.isArray(chatArg)) {
                    window.__hbsLastVirtualChat = chatArg.map((msg) => ({
                        mes: msg?.mes || '',
                        is_user: msg?.is_user,
                        is_system: msg?.is_system,
                        role: msg?.role,
                    }));
                }
                return result;
            };
        }

        const buildFirstWordSummary = (messages) => {
            if (!Array.isArray(messages)) {
                return '';
            }
            const userMessage = messages.find((message) => message?.role === 'user');
            const prompt = userMessage?.content || '';
            const separatorIndex = prompt.indexOf('\n\n');
            const payload = separatorIndex >= 0 ? prompt.slice(separatorIndex + 2) : prompt;

            const lines = payload.split('\n');
            const fragments = [];
            let collectUnprefixed = false;

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || line === '---') {
                    continue;
                }

                const match = line.match(/^(U|A|S1|S2):\s*(.*)$/);
                if (match) {
                    const tag = match[1];
                    const rest = match[2];
                    collectUnprefixed = tag === 'S1' || tag === 'S2';
                    if (rest) {
                        fragments.push(rest);
                    }
                    continue;
                }

                if (collectUnprefixed) {
                    fragments.push(line);
                }
            }

            const firstWords = fragments
                .map((text) => text.trim().split(/\s+/)[0])
                .filter(Boolean);

            return firstWords.join('\n---\n');
        };

        context.ConnectionManagerRequestService.sendRequest = async (profileId, messages) => {
            window.__hbsSummaryCalls += 1;
            if (config.summaryMode === 'firstWord') {
                const summary = buildFirstWordSummary(messages);
                if (summary) {
                    return { content: summary };
                }
            }
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
        summaryMode,
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

async function waitForAssistantCount(page, minCount) {
    await page.waitForFunction((expected) => {
        const chat = window.SillyTavern.getContext().chat || [];
        const count = chat.filter((msg) => msg && msg.is_user === false).length;
        return count >= expected;
    }, minCount);
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

async function getBucketCountsByLevel(page) {
    return page.evaluate(() => {
        const buckets = window.SillyTavern.getContext().chatMetadata?.hbs?.buckets || [];
        return buckets.reduce((acc, bucket) => {
            acc[bucket.level] = (acc[bucket.level] || 0) + 1;
            return acc;
        }, {});
    });
}

async function getBucketByLevel(page, level) {
    return page.evaluate((targetLevel) => {
        const buckets = window.SillyTavern.getContext().chatMetadata?.hbs?.buckets || [];
        const bucket = buckets.find((entry) => entry.level === targetLevel);
        if (!bucket) {
            return null;
        }
        return {
            level: bucket.level,
            start: bucket.start,
            end: bucket.end,
            summary: bucket.summary,
        };
    }, level);
}

async function getHbsStateSnapshot(page) {
    return page.evaluate(() => {
        const context = window.SillyTavern.getContext();
        const uaMessages = (context.chat || []).filter((msg) => msg && msg.is_system !== true
            && (msg.is_user === true || msg.is_user === false));
        const keepLastN = context.chatMetadata?.hbs?.keepLastN ?? 0;
        const historyEnd = Math.max(0, uaMessages.length - keepLastN);
        return {
            processedUntil: context.chatMetadata?.hbs?.processedUntil ?? 0,
            historyEnd,
            uaLength: uaMessages.length,
        };
    });
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
    await waitForAssistantCount(page, 1);

    await sendUserMessage(page, 'Hello from user 2');
    await waitForUserMessage(page, 'Hello from user 2');
    await waitForAssistantCount(page, 2);

    await assertBucketCount(page, 1);

    const summaryText = await getBucketSummary(page, 0);
    expect(summaryText).toContain('Hello');
    expect(summaryText).toContain('Mock');
    expect(summaryText).toContain('---');

    const summaryCalls = await getSummaryCalls(page);
    expect(summaryCalls).toBe(1);
});

test('HBS merges buckets with large messages', async ({ page }) => {
    const pageErrors = attachPageErrorHandlers(page);

    await openSillyTavern(page, pageErrors);

    const userPayload = 'AAA '.repeat(160).trim();
    const assistantPayload = 'BBB '.repeat(160).trim();
    const replyTexts = [
        `reply-1: ${assistantPayload}`,
        `reply-2: ${assistantPayload}`,
        `reply-3: ${assistantPayload}`,
        `reply-4: ${assistantPayload}`,
    ];

    await mockTextGeneration(page, replyTexts);
    await setupHbsTestContext(page, {
        summaryMode: 'firstWord',
        base: 2,
        keepLastN: 1,
        maxSummaryWords: 50,
    });

    await page.waitForSelector('#send_textarea');

    const userMessages = [
        `message-1: ${userPayload}`,
        `message-2: ${userPayload}`,
        `message-3: ${userPayload}`,
        `message-4: ${userPayload}`,
    ];

    for (let i = 0; i < userMessages.length; i += 1) {
        await sendUserMessage(page, userMessages[i]);
        await waitForUserMessage(page, `message-${i + 1}:`);
        await waitForAiReply(page, `reply-${i + 1}:`);
    }

    await assertBucketCount(page, 2);

    const bucketCounts = await getBucketCountsByLevel(page);
    expect(bucketCounts[1]).toBe(1);
    expect(bucketCounts[0]).toBe(1);

    const mergedBucket = await getBucketByLevel(page, 1);
    expect(mergedBucket).not.toBeNull();
    expect(mergedBucket.summary).toContain('message-1:');
    expect(mergedBucket.summary).toContain('reply-1:');
    expect(mergedBucket.summary).toContain('message-2:');
    expect(mergedBucket.summary).toContain('reply-2:');
    expect(mergedBucket.summary).toContain('---');

    const stateSnapshot = await getHbsStateSnapshot(page);
    expect(stateSnapshot.processedUntil).toBe(6);
    expect(stateSnapshot.historyEnd).toBe(7);
    expect(stateSnapshot.uaLength).toBe(8);
});

test('HBS injects summaries into generation prompt', async ({ page }) => {
    const pageErrors = attachPageErrorHandlers(page);

    await openSillyTavern(page, pageErrors);

    const capturedRequests = [];
    await mockTextGenerationWithCapture(page, (payload) => {
        capturedRequests.push(payload);
    });

    await setupHbsTestContext(page, {
        summaryMode: 'constant',
        summaryText: 'HBS_SUMMARY_MARKER',
        base: 2,
        keepLastN: 1,
        maxSummaryWords: 20,
    });

    await page.waitForSelector('#send_textarea');

    await sendUserMessage(page, 'Prompt one');
    await waitForUserMessage(page, 'Prompt one');
    await waitForAssistantCount(page, 1);

    await sendUserMessage(page, 'Prompt two');
    await waitForUserMessage(page, 'Prompt two');
    await waitForAssistantCount(page, 2);

    await assertBucketCount(page, 1);

    await sendUserMessage(page, 'Prompt three');
    await waitForUserMessage(page, 'Prompt three');
    await waitForAssistantCount(page, 3);

    expect(capturedRequests.length).toBeGreaterThan(0);
    const lastPayload = capturedRequests[capturedRequests.length - 1];
    const prompt = extractPromptFromPayload(lastPayload);
    expect(prompt).toContain('HBS_SUMMARY_MARKER');
});

test('HBS prompt preserves summary and live window ordering', async ({ page }) => {
    const pageErrors = attachPageErrorHandlers(page);

    await openSillyTavern(page, pageErrors);

    const replies = ['reply-1', 'reply-2', 'reply-3'];
    await mockTextGeneration(page, replies);

    await setupHbsTestContext(page, {
        summaryMode: 'constant',
        summaryText: 'HBS_SUMMARY_MARKER',
        base: 2,
        keepLastN: 1,
        maxSummaryWords: 20,
    });

    await page.waitForSelector('#send_textarea');

    await sendUserMessage(page, 'Prompt one');
    await waitForUserMessage(page, 'Prompt one');
    await waitForAiReply(page, 'reply-1');

    await sendUserMessage(page, 'Prompt two');
    await waitForUserMessage(page, 'Prompt two');
    await waitForAiReply(page, 'reply-2');

    await assertBucketCount(page, 1);

    await sendUserMessage(page, 'Prompt three');
    await waitForUserMessage(page, 'Prompt three');
    await waitForAiReply(page, 'reply-3');

    const virtualChat = await page.evaluate(() => window.__hbsLastVirtualChat || []);
    const summaryIndex = virtualChat.findIndex((msg) => msg?.mes?.includes('HBS_SUMMARY_MARKER'));
    const promptTwoIndex = virtualChat.findIndex((msg) => msg?.mes?.includes('Prompt two'));
    const replyTwoIndex = virtualChat.findIndex((msg) => msg?.mes?.includes('reply-2'));
    const promptThreeIndex = virtualChat.findIndex((msg) => msg?.mes?.includes('Prompt three'));

    expect(summaryIndex).toBeGreaterThan(-1);
    expect(promptThreeIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeLessThan(promptThreeIndex);
    if (promptTwoIndex !== -1) {
        expect(summaryIndex).toBeLessThan(promptTwoIndex);
        expect(promptTwoIndex).toBeLessThan(promptThreeIndex);
    }
    if (replyTwoIndex !== -1) {
        if (promptTwoIndex !== -1) {
            expect(replyTwoIndex).toBeGreaterThan(promptTwoIndex);
        }
        expect(replyTwoIndex).toBeLessThan(promptThreeIndex);
    }
});
