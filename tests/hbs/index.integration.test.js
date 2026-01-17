/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

let contextValue = null;
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

await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getStringHash: (value) => String(value.length),
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

function cleanTestEnvironment() {
    jest.clearAllMocks();
    installDomStubs();
    extensionSettings.hbs = {
        enabledGlobally: true,
        defaultBase: 2,
        defaultKeepLastN: 1,
        defaultMaxSummaryWords: 20,
        injectionTemplate: 'SUMMARY: {{summary}}',
        injectionRole: 'system',
        selectedProfileId: 'profile-1',
    };

    contextValue = {
        chat: [
            { mes: 'user-1', is_user: true, is_system: false },
            { mes: 'assistant-1', is_user: false, is_system: false },
            { mes: 'user-2', is_user: true, is_system: false },
        ],
        chatMetadata: {
            hbs: {
                enabled: true,
                base: 2,
                keepLastN: 1,
                maxSummaryWords: 20,
                processedUntil: 0,
                buckets: [],
                dirty: false,
                fingerprint: '',
            },
        },
        chatId: 'chat-1',
        saveMetadata: jest.fn(async () => {}),
        saveMetadataDebounced: jest.fn(),
        getTokenCountAsync: jest.fn(async (text) => text.length),
        extensionSettings: {
            hbs: {
                selectedProfileId: 'profile-1',
            },
        },
        ConnectionManagerRequestService: {
            sendRequest: jest.fn(async () => ({ content: 'SUM-1' })),
            getProfile: jest.fn(() => ({ id: 'profile-1', name: 'Mock Profile' })),
            handleDropdown: jest.fn(),
        },
    };
}

beforeEach(() => {
    cleanTestEnvironment();
});

describe('hbs_generate_interceptor integration', () => {
    test('injects real bucket summary into virtual chat', async () => {
        await loadModule();

        const abort = jest.fn();
        const chat = contextValue.chat;
        const lastMessage = chat[2];

        await window.hbs_generate_interceptor(chat, 1000, abort, 'normal');

        expect(contextValue.ConnectionManagerRequestService.sendRequest).toHaveBeenCalledTimes(1);
        expect(chat).toHaveLength(2);
        expect(chat[0].mes).toContain('SUMMARY: SUM-1');
        expect(chat[1]).toBe(lastMessage);
        expect(contextValue.chatMetadata.hbs.buckets).toHaveLength(1);
        expect(abort).not.toHaveBeenCalled();
    });
});
