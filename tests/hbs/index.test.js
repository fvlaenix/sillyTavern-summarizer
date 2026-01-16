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
    computeTokenStats: jest.fn(async () => ({
        bucketTokens: 0,
        remainderTokens: 0,
        liveTokens: 0,
        totalVirtual: 0,
        processedUntil: 0,
        historyEnd: 0,
        totalMessages: 0,
        bucketsCount: 0,
    })),
    resetHbsState: jest.fn(),
    checkDirty: jest.fn(() => false),
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

beforeEach(() => {
    installDomStubs();
    extensionSettings.hbs = undefined;
    handleDropdownMock = jest.fn();
    loadHbsStateMock = jest.fn((metadata) => metadata.hbs || null);
    initHbsStateMock = jest.fn((metadata) => {
        const state = { enabled: true, keepLastN: 1, processedUntil: 0, buckets: [] };
        metadata.hbs = state;
        return state;
    });
    ensureBucketsUpToDateMock = jest.fn(async () => {});
    buildVirtualChatMock = jest.fn(() => []);
    countTokensForMessagesMock = jest.fn(async () => 0);

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
});
