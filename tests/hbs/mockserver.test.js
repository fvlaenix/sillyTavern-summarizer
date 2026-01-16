import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { MockServer } from '../util/mock-server.js';

let currentContext = null;

await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    getContext: () => currentContext,
}));

await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getStringHash: (value) => String(value.length),
}));

const { callSummarize } = await import('../../public/scripts/extensions/third-party/hbs/bucket-manager.js');

describe('HBS callSummarize with MockServer', () => {
    const mockServer = new MockServer({ port: 3101, host: '127.0.0.1' });

    beforeAll(async () => {
        await mockServer.start();
    });

    afterAll(async () => {
        await mockServer.stop();
    });

    test('uses ConnectionManagerRequestService to return summary text', async () => {
        const sendRequest = jest.fn(async (_profileId, messages, maxTokens) => {
            const response = await fetch('http://127.0.0.1:3101/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    max_tokens: maxTokens,
                    messages: messages.map((msg) => ({ role: msg.role, content: msg.content })),
                }),
            });
            const json = await response.json();
            return { content: json.choices[0].message.content };
        });

        currentContext = {
            extensionSettings: {
                hbs: {
                    selectedProfileId: 'profile-1',
                },
            },
            getTokenCountAsync: async () => 1,
            ConnectionManagerRequestService: {
                sendRequest,
            },
        };

        const result = await callSummarize('leaf', 'U: hi', 5, {}, 'profile-1');

        expect(sendRequest).toHaveBeenCalledTimes(1);
        expect(sendRequest.mock.calls[0][2]).toBe(256);
        expect(result.text).toContain('Summarize the following conversation in under 5 words');
        expect(result.text).toContain('U: hi');
    });
});
