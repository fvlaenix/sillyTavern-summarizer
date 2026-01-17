import { describe, test, expect, beforeEach, jest } from '@jest/globals';

let currentContext = null;
let sendRequestMock = null;
let lastCreatedState = null;

await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    getContext: () => currentContext,
}));

await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getStringHash: (value) => String(value.length),
}));

const bucketManager = await import('../../public/scripts/extensions/third-party/hbs/bucket-manager.js');

const {
    isUserAssistant,
    loadHbsState,
    initHbsState,
    saveHbsState,
    computeFingerprint,
    checkDirty,
    ensureBucketsUpToDate,
    clampStateToHistoryEnd,
    buildVirtualChat,
    countTokensForMessages,
    computeTokenStats,
    resetHbsState,
    getBucketCountsByLevel,
    rebuildBuckets,
} = bucketManager;

/**
 * Cleans test environment to prevent state pollution between tests.
 * Must be called before each test.
 */
function cleanTestEnvironment() {
    jest.clearAllMocks();

    if (lastCreatedState) {
        lastCreatedState.buckets = [];
        lastCreatedState.processedUntil = 0;
        lastCreatedState.dirty = false;
        lastCreatedState.fingerprint = '';
        lastCreatedState = null;
    }

    sendRequestMock = jest.fn(async () => ({ content: 'summary' }));
    currentContext = {
        extensionSettings: {
            hbs: {
                selectedProfileId: 'profile-1',
            },
        },
        getTokenCountAsync: jest.fn(async (text) => text ? text.length : 0),
        ConnectionManagerRequestService: {
            sendRequest: sendRequestMock,
        },
    };
}

function makeMessage(text, isUser, isSystem = false) {
    return {
        mes: text,
        is_user: isUser,
        is_system: isSystem,
    };
}

function createState({ base = 2, keepLastN = 1, maxSummaryWords = 20 } = {}) {
    const chatMetadata = {};
    const state = initHbsState(chatMetadata, {
        defaultBase: base,
        defaultKeepLastN: keepLastN,
        defaultMaxSummaryWords: maxSummaryWords,
    });
    state.buckets = [];
    state.processedUntil = 0;
    state.dirty = false;
    state.fingerprint = '';
    lastCreatedState = state;
    return state;
}

beforeEach(() => {
    cleanTestEnvironment();
});

describe('isUserAssistant', () => {
    test('returns true for user message', () => {
        const msg = { mes: 'hello', is_user: true, is_system: false };
        expect(isUserAssistant(msg)).toBe(true);
    });

    test('returns true for assistant message', () => {
        const msg = { mes: 'hi there', is_user: false, is_system: false };
        expect(isUserAssistant(msg)).toBe(true);
    });

    test('returns false for system message', () => {
        const msg = { mes: 'system prompt', is_user: false, is_system: true };
        expect(isUserAssistant(msg)).toBe(false);
    });

    test('returns false for null', () => {
        expect(isUserAssistant(null)).toBe(false);
    });

    test('returns false for undefined', () => {
        expect(isUserAssistant(undefined)).toBe(false);
    });

    test('returns false for empty object', () => {
        expect(isUserAssistant({})).toBe(false);
    });

    test('returns false when is_user is undefined', () => {
        const msg = { mes: 'text', is_system: false };
        expect(isUserAssistant(msg)).toBe(false);
    });

    test('returns true when is_user is explicitly false (assistant)', () => {
        const msg = { mes: 'text', is_user: false };
        expect(isUserAssistant(msg)).toBe(true);
    });
});

describe('loadHbsState', () => {
    test('returns null when chatMetadata is null', () => {
        expect(loadHbsState(null)).toBeNull();
    });

    test('returns null when chatMetadata is undefined', () => {
        expect(loadHbsState(undefined)).toBeNull();
    });

    test('returns null when hbs property is missing', () => {
        expect(loadHbsState({})).toBeNull();
    });

    test('returns hbs state when present', () => {
        const state = { enabled: true, buckets: [] };
        const metadata = { hbs: state };
        expect(loadHbsState(metadata)).toBe(state);
    });
});

describe('initHbsState', () => {
    test('creates state with default values', () => {
        const metadata = {};
        const state = initHbsState(metadata, {});

        expect(state.version).toBe(1);
        expect(state.enabled).toBe(true);
        expect(state.base).toBe(8);
        expect(state.keepLastN).toBe(12);
        expect(state.maxSummaryWords).toBe(120);
        expect(state.processedUntil).toBe(0);
        expect(state.buckets).toEqual([]);
        expect(state.dirty).toBe(false);
        expect(state.fingerprint).toBe('');
    });

    test('uses provided default settings', () => {
        const metadata = {};
        const state = initHbsState(metadata, {
            defaultBase: 4,
            defaultKeepLastN: 6,
            defaultMaxSummaryWords: 50,
        });

        expect(state.base).toBe(4);
        expect(state.keepLastN).toBe(6);
        expect(state.maxSummaryWords).toBe(50);
    });

    test('stores state in chatMetadata', () => {
        const metadata = {};
        const state = initHbsState(metadata, {});

        expect(metadata.hbs).toBe(state);
    });
});

describe('saveHbsState', () => {
    test('saves state to chatMetadata', () => {
        const metadata = {};
        const state = { enabled: true, buckets: [{ level: 0 }] };

        saveHbsState(state, metadata);

        expect(metadata.hbs).toBe(state);
    });

    test('overwrites existing state', () => {
        const metadata = { hbs: { old: 'state' } };
        const newState = { enabled: false, buckets: [] };

        saveHbsState(newState, metadata);

        expect(metadata.hbs).toBe(newState);
        expect(metadata.hbs.old).toBeUndefined();
    });
});

describe('computeFingerprint', () => {
    test('returns empty string when historyEnd is 0', () => {
        const messages = [makeMessage('hello', true)];
        expect(computeFingerprint(messages, 0)).toBe('');
    });

    test('returns empty string when historyEnd is negative', () => {
        const messages = [makeMessage('hello', true)];
        expect(computeFingerprint(messages, -1)).toBe('');
    });

    test('returns empty string when messages array is empty', () => {
        expect(computeFingerprint([], 5)).toBe('');
    });

    test('computes fingerprint from messages up to historyEnd', () => {
        const messages = [
            makeMessage('msg1', true),
            makeMessage('msg2', false),
            makeMessage('msg3', true),
        ];

        const fp1 = computeFingerprint(messages, 2);
        const fp2 = computeFingerprint(messages, 3);

        expect(fp1).not.toBe('');
        expect(fp2).not.toBe('');
        expect(fp1).not.toBe(fp2);
    });

    test('same messages produce same fingerprint', () => {
        const messages1 = [makeMessage('hello', true), makeMessage('world', false)];
        const messages2 = [makeMessage('hello', true), makeMessage('world', false)];

        expect(computeFingerprint(messages1, 2)).toBe(computeFingerprint(messages2, 2));
    });

    test('different messages produce different fingerprints', () => {
        const messages1 = [makeMessage('hello', true)];
        const messages2 = [makeMessage('goodbye', true)];

        expect(computeFingerprint(messages1, 1)).not.toBe(computeFingerprint(messages2, 1));
    });

    test('handles messages with empty mes field', () => {
        const messages = [{ is_user: true }, makeMessage('valid', false)];
        const fp = computeFingerprint(messages, 2);
        expect(fp).not.toBe('');
    });
});

describe('checkDirty', () => {
    test('initializes fingerprint when not set', () => {
        const state = createState();
        state.fingerprint = '';
        const messages = [makeMessage('hello', true)];

        const result = checkDirty(state, messages, 1);

        expect(result).toBe(false);
        expect(state.fingerprint).not.toBe('');
    });

    test('returns false when fingerprint matches', () => {
        const messages = [makeMessage('hello', true)];
        const state = createState();
        state.processedUntil = 1;
        state.fingerprint = computeFingerprint(messages, 1);

        const result = checkDirty(state, messages, 1);

        expect(result).toBe(false);
        expect(state.dirty).toBeFalsy();
    });

    test('returns true and sets dirty when fingerprint differs', () => {
        const state = createState();
        state.processedUntil = 1;
        state.fingerprint = 'old-fingerprint';
        const messages = [makeMessage('new message', true)];

        const result = checkDirty(state, messages, 1);

        expect(result).toBe(true);
        expect(state.dirty).toBe(true);
    });

    test('returns existing dirty state', () => {
        const state = createState();
        state.dirty = true;
        state.fingerprint = 'some-fingerprint';
        state.processedUntil = 0;

        const result = checkDirty(state, [], 0);

        expect(result).toBe(true);
    });

    test('does not mark dirty when processedUntil is 0', () => {
        const state = createState();
        state.processedUntil = 0;
        state.fingerprint = 'old';
        const messages = [makeMessage('new', true)];

        const result = checkDirty(state, messages, 1);

        expect(result).toBe(false);
    });
});

describe('countTokensForMessages', () => {
    test('returns 0 for empty array', async () => {
        const result = await countTokensForMessages([]);
        expect(result).toBe(0);
    });

    test('counts tokens for single message', async () => {
        const messages = [makeMessage('hello', true)];
        const result = await countTokensForMessages(messages);
        expect(result).toBe(5);
    });

    test('sums tokens for multiple messages', async () => {
        const messages = [
            makeMessage('hello', true),
            makeMessage('world', false),
        ];
        const result = await countTokensForMessages(messages);
        expect(result).toBe(10);
    });

    test('skips messages without mes field', async () => {
        const messages = [
            makeMessage('hello', true),
            { is_user: false },
            makeMessage('world', false),
        ];
        const result = await countTokensForMessages(messages);
        expect(result).toBe(10);
    });

    test('handles empty mes field', async () => {
        const messages = [makeMessage('', true)];
        const result = await countTokensForMessages(messages);
        expect(result).toBe(0);
    });
});

describe('computeTokenStats', () => {
    test('computes stats for empty state', async () => {
        const state = createState({ keepLastN: 2 });
        const messages = [
            makeMessage('hello', true),
            makeMessage('world', false),
        ];

        const stats = await computeTokenStats(state, messages);

        expect(stats.bucketTokens).toBe(0);
        expect(stats.remainderTokens).toBe(0);
        expect(stats.liveTokens).toBe(10);
        expect(stats.totalVirtual).toBe(10);
        expect(stats.processedUntil).toBe(0);
        expect(stats.historyEnd).toBe(0);
        expect(stats.totalMessages).toBe(2);
        expect(stats.bucketsCount).toBe(0);
    });

    test('computes stats with buckets', async () => {
        const state = createState({ keepLastN: 1 });
        state.buckets = [
            { level: 0, start: 0, end: 2, summary: 'sum', summaryTokens: 10, createdAt: Date.now() },
        ];
        state.processedUntil = 2;

        const messages = [
            makeMessage('a', true),
            makeMessage('b', false),
            makeMessage('c', true),
            makeMessage('d', false),
        ];

        const stats = await computeTokenStats(state, messages);

        expect(stats.bucketTokens).toBe(10);
        expect(stats.remainderTokens).toBe(1);
        expect(stats.liveTokens).toBe(1);
        expect(stats.totalVirtual).toBe(12);
        expect(stats.processedUntil).toBe(2);
        expect(stats.historyEnd).toBe(3);
        expect(stats.totalMessages).toBe(4);
        expect(stats.bucketsCount).toBe(1);
    });

    test('computes stats with multiple buckets', async () => {
        const state = createState({ keepLastN: 1 });
        state.buckets = [
            { level: 1, start: 0, end: 4, summary: 'merged', summaryTokens: 15, createdAt: Date.now() },
            { level: 0, start: 4, end: 6, summary: 'leaf', summaryTokens: 8, createdAt: Date.now() },
        ];
        state.processedUntil = 6;

        const messages = [
            makeMessage('1', true),
            makeMessage('2', false),
            makeMessage('3', true),
            makeMessage('4', false),
            makeMessage('5', true),
            makeMessage('6', false),
            makeMessage('7', true),
            makeMessage('8', false),
        ];

        const stats = await computeTokenStats(state, messages);

        expect(stats.bucketTokens).toBe(23);
        expect(stats.remainderTokens).toBe(1);
        expect(stats.liveTokens).toBe(1);
        expect(stats.bucketsCount).toBe(2);
    });
});

describe('resetHbsState', () => {
    test('resets processedUntil to 0', () => {
        const state = createState();
        state.processedUntil = 10;

        resetHbsState(state);

        expect(state.processedUntil).toBe(0);
    });

    test('clears buckets array', () => {
        const state = createState();
        state.buckets = [{ level: 0 }, { level: 1 }];

        resetHbsState(state);

        expect(state.buckets).toEqual([]);
    });

    test('sets dirty to false', () => {
        const state = createState();
        state.dirty = true;

        resetHbsState(state);

        expect(state.dirty).toBe(false);
    });

    test('clears fingerprint', () => {
        const state = createState();
        state.fingerprint = 'some-hash';

        resetHbsState(state);

        expect(state.fingerprint).toBe('');
    });

    test('preserves other state properties', () => {
        const state = createState({ base: 4, keepLastN: 8, maxSummaryWords: 100 });
        state.enabled = false;

        resetHbsState(state);

        expect(state.base).toBe(4);
        expect(state.keepLastN).toBe(8);
        expect(state.maxSummaryWords).toBe(100);
        expect(state.enabled).toBe(false);
    });
});

describe('ensureBucketsUpToDate', () => {
    test('merges adjacent buckets', async () => {
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

    test('creates no buckets when not enough messages', async () => {
        const state = createState({ base: 4, keepLastN: 1 });

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
        ];

        await ensureBucketsUpToDate(state, uaMessages, 'chat-1');

        expect(sendRequestMock).not.toHaveBeenCalled();
        expect(state.buckets).toHaveLength(0);
        expect(state.processedUntil).toBe(0);
    });

    test('respects keepLastN boundary', async () => {
        const state = createState({ base: 2, keepLastN: 3 });

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
            makeMessage('a2', false),
            makeMessage('u3', true),
        ];

        await ensureBucketsUpToDate(state, uaMessages, 'chat-1');

        expect(state.processedUntil).toBe(2);
        expect(state.buckets).toHaveLength(1);
        expect(state.buckets[0].end).toBe(2);
    });

    test('updates fingerprint after processing', async () => {
        const state = createState({ base: 2, keepLastN: 1 });
        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
        ];

        await ensureBucketsUpToDate(state, uaMessages, 'chat-1');

        expect(state.fingerprint).not.toBe('');
        expect(state.dirty).toBe(false);
    });
});

describe('clampStateToHistoryEnd', () => {
    test('trims buckets when history shrinks', () => {
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

    test('does nothing when historyEnd is larger', () => {
        const state = createState();
        state.buckets = [{ level: 0, start: 0, end: 4 }];
        state.processedUntil = 4;
        state.dirty = false;

        clampStateToHistoryEnd(state, 10);

        expect(state.buckets).toHaveLength(1);
        expect(state.processedUntil).toBe(4);
        expect(state.dirty).toBe(false);
    });

    test('removes all buckets when historyEnd is 0', () => {
        const state = createState();
        state.buckets = [
            { level: 0, start: 0, end: 2 },
            { level: 0, start: 2, end: 4 },
        ];
        state.processedUntil = 4;

        clampStateToHistoryEnd(state, 0);

        expect(state.buckets).toHaveLength(0);
        expect(state.processedUntil).toBe(0);
        expect(state.dirty).toBe(true);
    });
});

describe('buildVirtualChat', () => {
    test('injects summary and preserves message order', () => {
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

    test('uses system role when specified', () => {
        const state = createState({ keepLastN: 1 });
        state.buckets = [{ level: 0, start: 0, end: 2, summary: 'test' }];
        state.processedUntil = 2;

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
        ];

        const virtual = buildVirtualChat(state, uaMessages, {
            injectionRole: 'system',
        });

        expect(virtual[0].role).toBe('system');
        expect(virtual[0].is_system).toBe(true);
        expect(virtual[0].is_user).toBe(false);
    });

    test('uses user role when specified', () => {
        const state = createState({ keepLastN: 1 });
        state.buckets = [{ level: 0, start: 0, end: 2, summary: 'test' }];
        state.processedUntil = 2;

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
        ];

        const virtual = buildVirtualChat(state, uaMessages, {
            injectionRole: 'user',
        });

        expect(virtual[0].role).toBe('user');
        expect(virtual[0].is_system).toBe(false);
        expect(virtual[0].is_user).toBe(true);
    });

    test('applies template to summary', () => {
        const state = createState({ keepLastN: 1 });
        state.buckets = [{ level: 0, start: 0, end: 2, summary: 'the summary text' }];
        state.processedUntil = 2;

        const uaMessages = [makeMessage('u1', true), makeMessage('a1', false), makeMessage('u2', true)];

        const virtual = buildVirtualChat(state, uaMessages, {
            injectionTemplate: 'BEFORE {{summary}} AFTER',
        });

        expect(virtual[0].mes).toBe('BEFORE the summary text AFTER');
    });

    test('combines multiple bucket summaries', () => {
        const state = createState({ keepLastN: 1 });
        state.buckets = [
            { level: 1, start: 0, end: 4, summary: 'first summary' },
            { level: 0, start: 4, end: 6, summary: 'second summary' },
        ];
        state.processedUntil = 6;

        const uaMessages = Array.from({ length: 7 }, (_, i) => makeMessage(`m${i}`, i % 2 === 0));

        const virtual = buildVirtualChat(state, uaMessages, {
            injectionTemplate: '{{summary}}',
        });

        expect(virtual[0].mes).toContain('first summary');
        expect(virtual[0].mes).toContain('second summary');
    });

    test('includes remainder messages', () => {
        const state = createState({ base: 4, keepLastN: 1 });
        state.buckets = [{ level: 0, start: 0, end: 4, summary: 'bucket' }];
        state.processedUntil = 4;

        const uaMessages = [
            makeMessage('m0', true),
            makeMessage('m1', false),
            makeMessage('m2', true),
            makeMessage('m3', false),
            makeMessage('m4', true),
            makeMessage('m5', false),
        ];

        const virtual = buildVirtualChat(state, uaMessages, {});

        expect(virtual).toHaveLength(3);
        expect(virtual[0].mes).toContain('bucket');
        expect(virtual[1]).toBe(uaMessages[4]);
        expect(virtual[2]).toBe(uaMessages[5]);
    });

    test('returns only live messages when no buckets', () => {
        const state = createState({ keepLastN: 2 });
        state.buckets = [];
        state.processedUntil = 0;

        const uaMessages = [
            makeMessage('m0', true),
            makeMessage('m1', false),
            makeMessage('m2', true),
        ];

        const virtual = buildVirtualChat(state, uaMessages, {});

        expect(virtual).toHaveLength(3);
        expect(virtual[0]).toBe(uaMessages[0]);
        expect(virtual[1]).toBe(uaMessages[1]);
        expect(virtual[2]).toBe(uaMessages[2]);
    });
});

describe('getBucketCountsByLevel', () => {
    test('tallies levels', () => {
        const state = createState();
        state.buckets = [
            { level: 0, start: 0, end: 8 },
            { level: 1, start: 0, end: 16 },
            { level: 1, start: 16, end: 32 },
        ];

        const counts = getBucketCountsByLevel(state);

        expect(counts).toEqual({ 0: 1, 1: 2 });
    });

    test('returns empty object for no buckets', () => {
        const state = createState();
        state.buckets = [];

        const counts = getBucketCountsByLevel(state);

        expect(counts).toEqual({});
    });

    test('handles single bucket', () => {
        const state = createState();
        state.buckets = [{ level: 3 }];

        const counts = getBucketCountsByLevel(state);

        expect(counts).toEqual({ 3: 1 });
    });
});

describe('rebuildBuckets', () => {
    test('restores old state on failure', async () => {
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

    test('rebuilds from scratch on success', async () => {
        const state = createState({ base: 2, keepLastN: 1 });
        state.buckets = [{ level: 0, start: 0, end: 2, summary: 'old' }];
        state.processedUntil = 2;
        state.dirty = true;

        const uaMessages = [
            makeMessage('u1', true),
            makeMessage('a1', false),
            makeMessage('u2', true),
            makeMessage('a2', false),
            makeMessage('u3', true),
        ];

        await rebuildBuckets(state, uaMessages, 'chat-1');

        expect(state.processedUntil).toBe(4);
        expect(state.buckets).toHaveLength(1);
        expect(state.buckets[0].level).toBe(1);
        expect(state.buckets[0].summary).toBe('summary');
        expect(state.dirty).toBe(false);
    });
});
