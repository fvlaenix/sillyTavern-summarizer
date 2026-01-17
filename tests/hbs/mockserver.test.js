import { describe, test, expect, beforeEach, jest } from '@jest/globals';

let currentContext = null;
let sendRequestMock = null;

await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    getContext: () => currentContext,
}));

await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getStringHash: (value) => String(value.length),
}));

const { callSummarize, formatMessagesForLeaf, formatMessagesForMerge } = await import(
    '../../public/scripts/extensions/third-party/hbs/bucket-manager.js'
);

function setupContext(overrides = {}) {
    sendRequestMock = jest.fn(async () => ({ content: 'Mock summary response' }));
    currentContext = {
        extensionSettings: {
            hbs: {
                selectedProfileId: 'default-profile',
            },
        },
        getTokenCountAsync: jest.fn(async () => 1),
        ConnectionManagerRequestService: {
            sendRequest: sendRequestMock,
        },
        ...overrides,
    };
}

beforeEach(() => {
    setupContext();
});

describe('callSummarize', () => {
    describe('leaf mode', () => {
        test('sends correct system prompt for leaf summarization', async () => {
            await callSummarize('leaf', 'U: Hello\n\nA: Hi there', 50, {}, 'test-profile');

            expect(sendRequestMock).toHaveBeenCalledTimes(1);
            const [profileId, messages] = sendRequestMock.mock.calls[0];

            expect(profileId).toBe('test-profile');
            expect(messages).toHaveLength(2);
            expect(messages[0].role).toBe('system');
            expect(messages[0].content).toContain('precise summarizer');
            expect(messages[0].content).toContain('Summarize the following conversation');
            expect(messages[0].content).toContain('key facts');
        });

        test('sends correct user prompt with maxWords and text', async () => {
            const inputText = 'U: Hello\n\nA: Hi there';
            await callSummarize('leaf', inputText, 75, {}, 'test-profile');

            const [, messages] = sendRequestMock.mock.calls[0];

            expect(messages[1].role).toBe('user');
            expect(messages[1].content).toContain('Summarize the following conversation in under 75 words');
            expect(messages[1].content).toContain(inputText);
        });

        test('passes correct options to sendRequest', async () => {
            await callSummarize('leaf', 'test', 50, {}, 'test-profile');

            const [, , maxTokens, options] = sendRequestMock.mock.calls[0];

            expect(maxTokens).toBe(256);
            expect(options).toEqual({
                stream: false,
                extractData: true,
                includePreset: true,
                includeInstruct: false,
            });
        });
    });

    describe('merge mode', () => {
        test('sends correct system prompt for merge summarization', async () => {
            await callSummarize('merge', 'S1: First\n\nS2: Second', 50, {}, 'test-profile');

            expect(sendRequestMock).toHaveBeenCalledTimes(1);
            const [, messages] = sendRequestMock.mock.calls[0];

            expect(messages[0].role).toBe('system');
            expect(messages[0].content).toContain('precise summarizer');
            expect(messages[0].content).toContain('Merge these two consecutive summaries');
            expect(messages[0].content).toContain('chronological order');
        });

        test('sends correct user prompt for merge with maxWords', async () => {
            const inputText = 'S1: Summary one\n\nS2: Summary two';
            await callSummarize('merge', inputText, 100, {}, 'test-profile');

            const [, messages] = sendRequestMock.mock.calls[0];

            expect(messages[1].role).toBe('user');
            expect(messages[1].content).toContain('Merge these summaries into one summary under 100 words');
            expect(messages[1].content).toContain(inputText);
        });
    });

    describe('profile ID resolution', () => {
        test('uses provided profileId when given', async () => {
            await callSummarize('leaf', 'test', 50, {}, 'explicit-profile');

            const [profileId] = sendRequestMock.mock.calls[0];
            expect(profileId).toBe('explicit-profile');
        });

        test('falls back to extensionSettings when profileId not provided', async () => {
            setupContext({
                extensionSettings: {
                    hbs: {
                        selectedProfileId: 'settings-profile',
                    },
                },
            });

            await callSummarize('leaf', 'test', 50, {});

            const [profileId] = sendRequestMock.mock.calls[0];
            expect(profileId).toBe('settings-profile');
        });

        test('throws error when no profile available', async () => {
            setupContext({
                extensionSettings: {
                    hbs: {
                        selectedProfileId: null,
                    },
                },
            });

            await expect(callSummarize('leaf', 'test', 50, {})).rejects.toThrow(
                'No connection profile selected'
            );
        });
    });

    describe('response handling', () => {
        test('returns trimmed content from response', async () => {
            sendRequestMock.mockResolvedValueOnce({ content: '  Summary with spaces  ' });

            const result = await callSummarize('leaf', 'test', 50, {}, 'profile');

            expect(result.text).toBe('Summary with spaces');
            expect(result.tokens).toBe(0);
            expect(result.usage).toBeNull();
        });

        test('throws error on empty response', async () => {
            sendRequestMock.mockResolvedValueOnce({ content: '' });

            await expect(callSummarize('leaf', 'test', 50, {}, 'profile')).rejects.toThrow(
                'Empty response from Connection Manager'
            );
        });

        test('throws error on null response', async () => {
            sendRequestMock.mockResolvedValueOnce(null);

            await expect(callSummarize('leaf', 'test', 50, {}, 'profile')).rejects.toThrow(
                'Empty response from Connection Manager'
            );
        });

        test('wraps sendRequest errors', async () => {
            sendRequestMock.mockRejectedValueOnce(new Error('Network error'));

            await expect(callSummarize('leaf', 'test', 50, {}, 'profile')).rejects.toThrow(
                'Summarization failed: Network error'
            );
        });
    });
});

describe('formatMessagesForLeaf', () => {
    test('formats user message with U: prefix', () => {
        const messages = [{ mes: 'Hello world', is_user: true }];

        const result = formatMessagesForLeaf(messages);

        expect(result).toBe('U: Hello world');
    });

    test('formats assistant message with A: prefix', () => {
        const messages = [{ mes: 'Hi there', is_user: false }];

        const result = formatMessagesForLeaf(messages);

        expect(result).toBe('A: Hi there');
    });

    test('joins multiple messages with double newline', () => {
        const messages = [
            { mes: 'Hello', is_user: true },
            { mes: 'Hi', is_user: false },
            { mes: 'How are you?', is_user: true },
        ];

        const result = formatMessagesForLeaf(messages);

        expect(result).toBe('U: Hello\n\nA: Hi\n\nU: How are you?');
    });

    test('trims message text', () => {
        const messages = [{ mes: '  Hello with spaces  ', is_user: true }];

        const result = formatMessagesForLeaf(messages);

        expect(result).toBe('U: Hello with spaces');
    });

    test('handles empty messages array', () => {
        const result = formatMessagesForLeaf([]);

        expect(result).toBe('');
    });

    test('handles messages with empty text', () => {
        const messages = [
            { mes: '', is_user: true },
            { mes: 'Valid', is_user: false },
        ];

        const result = formatMessagesForLeaf(messages);

        expect(result).toBe('U: \n\nA: Valid');
    });

    test('handles messages with undefined mes field', () => {
        const messages = [
            { is_user: true },
            { mes: 'Valid', is_user: false },
        ];

        const result = formatMessagesForLeaf(messages);

        expect(result).toBe('U: \n\nA: Valid');
    });
});

describe('formatMessagesForMerge', () => {
    test('formats two summaries with S1 and S2 prefixes', () => {
        const result = formatMessagesForMerge('First summary', 'Second summary');

        expect(result).toBe('S1: First summary\n\nS2: Second summary');
    });

    test('handles empty summaries', () => {
        const result = formatMessagesForMerge('', '');

        expect(result).toBe('S1: \n\nS2: ');
    });

    test('handles multiline summaries', () => {
        const summary1 = 'Line 1\nLine 2';
        const summary2 = 'Line A\nLine B';

        const result = formatMessagesForMerge(summary1, summary2);

        expect(result).toBe('S1: Line 1\nLine 2\n\nS2: Line A\nLine B');
    });
});
