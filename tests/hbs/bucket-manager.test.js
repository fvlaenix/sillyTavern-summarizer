import { describe, test, expect, beforeEach, jest } from '@jest/globals';

let currentContext = null;
let sendRequestMock = null;

await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    getContext: () => currentContext,
}));

await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getStringHash: (value) => String(value.length),
}));

const bucketManager = await import('../../public/scripts/extensions/third-party/hbs/bucket-manager.js');

const {
    initHbsState,
    ensureBucketsUpToDate,
    clampStateToHistoryEnd,
    buildVirtualChat,
    checkDirty,
    getBucketCountsByLevel,
    rebuildBuckets,
} = bucketManager;

function makeMessage(text, isUser) {
    return {
        mes: text,
        is_user: isUser,
        is_system: false,
    };
}

function setupContext() {
    sendRequestMock = jest.fn(async () => ({ content: 'summary' }));
    currentContext = {
        extensionSettings: {
            hbs: {
                selectedProfileId: 'profile-1',
            },
        },
        getTokenCountAsync: jest.fn(async () => 1),
        ConnectionManagerRequestService: {
            sendRequest: sendRequestMock,
        },
    };
}

function createState({ base = 2, keepLastN = 1, maxSummaryWords = 20 } = {}) {
    const chatMetadata = {};
    const state = initHbsState(chatMetadata, {
        defaultBase: base,
        defaultKeepLastN: keepLastN,
        defaultMaxSummaryWords: maxSummaryWords,
    });
    return state;
}

beforeEach(() => {
    setupContext();
});

describe('HBS bucket manager', () => {
    test('ensureBucketsUpToDate merges adjacent buckets', async () => {
        const state = createState({ base: 2, keepLastN: 1, maxSummaryWords: 10 });
        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
            makeMessage('a2', false),
            makeMessage('u3', true),
        ];

        await ensureBucketsUpToDate(state, uaMessages, 'chat-1');

        expect(sendRequestMock).toHaveBeenCalledTimes(3);
        expect(state.processedUntil).toBe(4);
        expect(state.buckets).toHaveLength(1);
        expect(state.buckets[0].level).toBe(1);
        expect(state.buckets[0].start).toBe(0);
        expect(state.buckets[0].end).toBe(4);
    });

    test('clampStateToHistoryEnd trims buckets when history shrinks', () => {
        const state = createState({ base: 2, keepLastN: 1 });
        state.buckets = [
            { level: 0, start: 0, end: 4, summary: 's1', summaryTokens: 1, createdAt: Date.now() },
            { level: 0, start: 4, end: 8, summary: 's2', summaryTokens: 1, createdAt: Date.now() },
        ];
        state.processedUntil = 8;
        state.dirty = false;

        clampStateToHistoryEnd(state, 6);

        expect(state.buckets).toHaveLength(1);
        expect(state.buckets[0].end).toBe(4);
        expect(state.processedUntil).toBe(4);
        expect(state.dirty).toBe(true);
    });

    test('buildVirtualChat injects summary and preserves message order', () => {
        const state = createState({ base: 2, keepLastN: 1 });
        state.buckets = [
            { level: 0, start: 0, end: 2, summary: 'sum', summaryTokens: 1, createdAt: Date.now() },
        ];
        state.processedUntil = 2;

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
            makeMessage('a2', false),
        ];

        const virtual = buildVirtualChat(state, uaMessages, {
            injectionRole: 'assistant',
            injectionTemplate: 'Summary:\n{{summary}}',
        });

        expect(virtual[0].role).toBe('assistant');
        expect(virtual[0].is_system).toBe(false);
        expect(virtual[0].is_user).toBe(false);
        expect(virtual[1]).toBe(uaMessages[2]);
        expect(virtual[2]).toBe(uaMessages[3]);
    });

    test('checkDirty flags changes when history fingerprint differs', () => {
        const state = createState({ base: 2, keepLastN: 1 });
        state.processedUntil = 2;
        state.fingerprint = 'old';

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
        ];

        const dirty = checkDirty(state, uaMessages, 2);

        expect(dirty).toBe(true);
        expect(state.dirty).toBe(true);
    });

    test('getBucketCountsByLevel tallies levels', () => {
        const state = createState();
        state.buckets = [
            { level: 0, start: 0, end: 8 },
            { level: 1, start: 0, end: 16 },
            { level: 1, start: 16, end: 32 },
        ];

        const counts = getBucketCountsByLevel(state);

        expect(counts).toEqual({ 0: 1, 1: 2 });
    });

    test('rebuildBuckets restores old state on failure', async () => {
        const state = createState({ base: 2, keepLastN: 1 });
        state.buckets = [
            { level: 0, start: 0, end: 2, summary: 'old', summaryTokens: 1, createdAt: Date.now() },
        ];
        state.processedUntil = 2;

        sendRequestMock.mockRejectedValueOnce(new Error('boom'));

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
        ];

        await expect(rebuildBuckets(state, uaMessages, 'chat-1')).rejects.toThrow('Summarization failed');

        expect(state.processedUntil).toBe(2);
        expect(state.buckets).toHaveLength(1);
        expect(state.buckets[0].summary).toBe('old');
    });
});
