/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

let contextValue = null;
let handleDropdownMock = null;
let loadHbsStateMock = null;
let initHbsStateMock = null;
let ensureBucketsUpToDateMock = null;
let buildVirtualChatMock = null;
let countTokensForMessagesMock = null;
let computeTokenStatsMock = null;
let checkDirtyMock = null;

const extensionSettings = {};
const eventSource = { on: jest.fn() };
const event_types = { CHAT_CHANGED: 'chat_changed' };

await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    getContext: () => contextValue,
    extension_settings: extensionSettings,
}));

await jest.unstable_mockModule('../../public/script.js', () => ({
    eventSource,
    event_types,
    saveSettingsDebounced: jest.fn(),
}));

await jest.unstable_mockModule('../../public/scripts/extensions/third-party/hbs/bucket-manager.js', () => ({
    loadHbsState: jest.fn((...args) => loadHbsStateMock(...args)),
    initHbsState: jest.fn((...args) => initHbsStateMock(...args)),
    saveHbsState: jest.fn((state, metadata) => {
        metadata.hbs = state;
    }),
    isUserAssistant: jest.fn((msg) => msg && !msg.is_system),
    ensureBucketsUpToDate: jest.fn(async (...args) => ensureBucketsUpToDateMock(...args)),
    buildVirtualChat: jest.fn((...args) => buildVirtualChatMock(...args)),
    computeTokenStats: jest.fn(async (...args) => computeTokenStatsMock(...args)),
    resetHbsState: jest.fn(),
    checkDirty: jest.fn((...args) => checkDirtyMock(...args)),
    countTokensForMessages: jest.fn(async (...args) => countTokensForMessagesMock(...args)),
    getBucketCountsByLevel: jest.fn(() => ({})),
    rebuildBuckets: jest.fn(async () => {}),
}));

function installDomStubs() {
    document.body.innerHTML = '<div id="extensions_settings2"></div>';

    global.$ = (selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return {
            length: elements.length,
            append: (html) => {
                elements.forEach((el) => el.insertAdjacentHTML('beforeend', html));
            },
            empty: () => {
                elements.forEach((el) => {
                    el.innerHTML = '';
                });
            },
        };
    };

    global.jQuery = (arg) => {
        if (typeof arg === 'function') {
            return arg();
        }
        return global.$(arg);
    };

    global.toastr = {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
    };

    global.confirm = jest.fn(() => true);
}

async function loadModule() {
    await import('../../public/scripts/extensions/third-party/hbs/index.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Cleans test environment to prevent state pollution between tests.
 */
function cleanTestEnvironment() {
    jest.clearAllMocks();

    installDomStubs();
    extensionSettings.hbs = undefined;

    handleDropdownMock = jest.fn();
    loadHbsStateMock = jest.fn((metadata) => metadata.hbs || null);
    initHbsStateMock = jest.fn((metadata) => {
        const state = {
            enabled: true,
            keepLastN: 1,
            processedUntil: 0,
            buckets: [],
            base: 2,
            maxSummaryWords: 20,
            dirty: false,
            fingerprint: '',
        };
        metadata.hbs = state;
        return state;
    });
    ensureBucketsUpToDateMock = jest.fn(async () => {});
    buildVirtualChatMock = jest.fn(() => []);
    countTokensForMessagesMock = jest.fn(async () => 0);
    computeTokenStatsMock = jest.fn(async () => ({
        bucketTokens: 0,
        remainderTokens: 0,
        liveTokens: 0,
        totalVirtual: 0,
        processedUntil: 0,
        historyEnd: 0,
        totalMessages: 0,
        bucketsCount: 0,
    }));
    checkDirtyMock = jest.fn(() => false);

    contextValue = {
        chat: [
            { mes: 'hi', is_user: true, is_system: false },
        ],
        chatMetadata: {},
        chatId: 'chat-1',
        saveMetadata: jest.fn(async () => {}),
        saveMetadataDebounced: jest.fn(),
        getTokenCountAsync: jest.fn(async () => 1),
        ConnectionManagerRequestService: {
            handleDropdown: handleDropdownMock,
            getProfile: jest.fn(() => ({ id: 'profile-1', name: 'Mock Profile' })),
        },
    };

    eventSource.on.mockClear();
}

beforeEach(() => {
    cleanTestEnvironment();
});

describe('HBS index UI', () => {
    test('injects settings UI and wires profile dropdown', async () => {
        await loadModule();

        const settingsPanel = document.querySelector('#hbs_settings');
        expect(settingsPanel).toBeTruthy();

        expect(handleDropdownMock).toHaveBeenCalledWith(
            '#hbs_profile_select',
            null,
            expect.any(Function)
        );

        expect(eventSource.on).toHaveBeenCalledWith(event_types.CHAT_CHANGED, expect.any(Function));
    });
});

describe('hbs_generate_interceptor', () => {
    test('aborts when live window exceeds context size', async () => {
        countTokensForMessagesMock.mockResolvedValue(999);
        await loadModule();

        const abort = jest.fn();
        const chat = [
            { mes: 'hi', is_user: true, is_system: false },
        ];
        contextValue.chatMetadata.hbs = {
            enabled: true,
            keepLastN: 1,
            processedUntil: 0,
            buckets: [],
        };

        await window.hbs_generate_interceptor(chat, 100, abort, 'normal');

        expect(countTokensForMessagesMock).toHaveBeenCalled();
        expect(abort).toHaveBeenCalledWith(true);
        expect(ensureBucketsUpToDateMock).not.toHaveBeenCalled();
    });

    test('normal flow builds buckets and splices chat', async () => {
        const virtualChat = [
            { mes: 'summary', role: 'system', is_system: true, is_user: false },
            { mes: 'recent message', is_user: true, is_system: false },
        ];
        buildVirtualChatMock.mockReturnValue(virtualChat);
        countTokensForMessagesMock.mockResolvedValue(10);
        computeTokenStatsMock.mockResolvedValue({
            bucketTokens: 5,
            remainderTokens: 0,
            liveTokens: 10,
            totalVirtual: 15,
            processedUntil: 2,
            historyEnd: 2,
            totalMessages: 3,
            bucketsCount: 1,
        });

        await loadModule();

        const abort = jest.fn();
        const chat = [
            { mes: 'old1', is_user: true, is_system: false },
            { mes: 'old2', is_user: false, is_system: false },
            { mes: 'recent', is_user: true, is_system: false },
        ];
        contextValue.chat = chat;
        contextValue.chatMetadata.hbs = {
            enabled: true,
            keepLastN: 1,
            processedUntil: 0,
            buckets: [],
            base: 2,
            maxSummaryWords: 20,
        };

        await window.hbs_generate_interceptor(chat, 1000, abort, 'normal');

        expect(ensureBucketsUpToDateMock).toHaveBeenCalled();
        expect(buildVirtualChatMock).toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        expect(chat).toHaveLength(2);
        expect(chat[0]).toBe(virtualChat[0]);
        expect(chat[1]).toBe(virtualChat[1]);
    });

    test('aborts when total virtual tokens exceed context size', async () => {
        countTokensForMessagesMock.mockResolvedValue(10);
        computeTokenStatsMock.mockResolvedValue({
            bucketTokens: 500,
            remainderTokens: 100,
            liveTokens: 10,
            totalVirtual: 610,
            processedUntil: 4,
            historyEnd: 4,
            totalMessages: 5,
            bucketsCount: 2,
        });

        await loadModule();

        const abort = jest.fn();
        const chat = [
            { mes: 'msg1', is_user: true, is_system: false },
            { mes: 'msg2', is_user: false, is_system: false },
        ];
        contextValue.chat = chat;
        contextValue.chatMetadata.hbs = {
            enabled: true,
            keepLastN: 1,
            processedUntil: 0,
            buckets: [],
        };

        await window.hbs_generate_interceptor(chat, 500, abort, 'normal');

        expect(ensureBucketsUpToDateMock).toHaveBeenCalled();
        expect(abort).toHaveBeenCalledWith(true);
        expect(global.toastr.error).toHaveBeenCalled();
    });

    test('skips processing when HBS is disabled', async () => {
        await loadModule();

        const abort = jest.fn();
        const originalChat = [
            { mes: 'msg1', is_user: true, is_system: false },
        ];
        const chat = [...originalChat];
        contextValue.chat = chat;
        contextValue.chatMetadata.hbs = {
            enabled: false,
            keepLastN: 1,
            processedUntil: 0,
            buckets: [],
        };

        await window.hbs_generate_interceptor(chat, 1000, abort, 'normal');

        expect(ensureBucketsUpToDateMock).not.toHaveBeenCalled();
        expect(buildVirtualChatMock).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        expect(chat).toEqual(originalChat);
    });

    test('skips processing when no chat metadata', async () => {
        await loadModule();

        const abort = jest.fn();
        const chat = [
            { mes: 'msg1', is_user: true, is_system: false },
        ];
        contextValue.chatMetadata = {};

        await window.hbs_generate_interceptor(chat, 1000, abort, 'normal');

        expect(ensureBucketsUpToDateMock).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
    });

    test('skips processing for quiet type', async () => {
        countTokensForMessagesMock.mockResolvedValue(10);
        await loadModule();

        const abort = jest.fn();
        const chat = [
            { mes: 'msg1', is_user: true, is_system: false },
        ];
        contextValue.chat = chat;
        contextValue.chatMetadata.hbs = {
            enabled: true,
            keepLastN: 1,
            processedUntil: 0,
            buckets: [],
        };

        await window.hbs_generate_interceptor(chat, 1000, abort, 'quiet');

        expect(ensureBucketsUpToDateMock).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
    });

    test('filters system messages from UA messages', async () => {
        buildVirtualChatMock.mockReturnValue([]);
        countTokensForMessagesMock.mockResolvedValue(5);
        computeTokenStatsMock.mockResolvedValue({
            bucketTokens: 0,
            remainderTokens: 0,
            liveTokens: 5,
            totalVirtual: 5,
            processedUntil: 0,
            historyEnd: 0,
            totalMessages: 2,
            bucketsCount: 0,
        });

        await loadModule();

        const abort = jest.fn();
        const chat = [
            { mes: 'system prompt', is_user: false, is_system: true },
            { mes: 'user msg', is_user: true, is_system: false },
            { mes: 'assistant reply', is_user: false, is_system: false },
        ];
        contextValue.chat = chat;
        contextValue.chatMetadata.hbs = {
            enabled: true,
            keepLastN: 1,
            processedUntil: 0,
            buckets: [],
        };

        await window.hbs_generate_interceptor(chat, 1000, abort, 'normal');

        const ensureCall = ensureBucketsUpToDateMock.mock.calls[0];
        const uaMessages = ensureCall[1];
        expect(uaMessages).toHaveLength(2);
        expect(uaMessages.every(m => !m.is_system)).toBe(true);
    });
});
