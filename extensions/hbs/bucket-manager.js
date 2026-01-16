import { getContext } from '../../../scripts/extensions.js';
import { getStringHash } from '../../../scripts/utils.js';

const DEFAULT_STATE = {
    version: 1,
    enabled: true,
    base: 8,
    keepLastN: 12,
    maxSummaryWords: 120,
    processedUntil: 0,
    buckets: [],
    dirty: false,
    fingerprint: '',
};

export function isUserAssistant(msg) {
    if (!msg) return false;
    if (msg.is_system) return false;
    return msg.is_user === true || msg.is_user === false;
}

export function loadHbsState(chatMetadata) {
    if (!chatMetadata || !chatMetadata.hbs) {
        return null;
    }
    return chatMetadata.hbs;
}

export function initHbsState(chatMetadata, defaultSettings) {
    const state = {
        ...DEFAULT_STATE,
        base: defaultSettings.defaultBase || DEFAULT_STATE.base,
        keepLastN: defaultSettings.defaultKeepLastN || DEFAULT_STATE.keepLastN,
        maxSummaryWords: defaultSettings.defaultMaxSummaryWords || DEFAULT_STATE.maxSummaryWords,
    };

    chatMetadata.hbs = state;
    return state;
}

export function saveHbsState(state, chatMetadata) {
    chatMetadata.hbs = state;
}

export function computeFingerprint(uaMessages, historyEnd) {
    if (historyEnd <= 0 || !uaMessages.length) {
        return '';
    }

    const relevantMessages = uaMessages.slice(0, historyEnd);
    const messagesText = relevantMessages.map(m => m.mes || '').join('|||');
    return getStringHash(messagesText).toString();
}

export function checkDirty(state, uaMessages, historyEnd) {
    const currentFingerprint = computeFingerprint(uaMessages, historyEnd);

    if (!state.fingerprint) {
        state.fingerprint = currentFingerprint;
        return false;
    }

    if (state.processedUntil > 0 && currentFingerprint !== state.fingerprint) {
        state.dirty = true;
        return true;
    }

    return state.dirty;
}

export function formatMessagesForLeaf(messages) {
    return messages
        .map(msg => {
            const role = msg.is_user ? 'U' : 'A';
            const text = (msg.mes || '').trim();
            return `${role}: ${text}`;
        })
        .join('\n\n');
}

export function formatMessagesForMerge(summary1, summary2) {
    return `S1: ${summary1}\n\nS2: ${summary2}`;
}

export async function callSummarize(mode, text, maxWords, meta = {}) {
    try {
        const response = await fetch('/api/plugins/hbs/summarize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                mode,
                text,
                maxWords,
                meta,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Server returned ${response.status}`);
        }

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || 'Summarization failed');
        }

        return {
            text: data.summary,
            tokens: data.usage?.completion_tokens || 0,
            usage: data.usage,
        };
    } catch (error) {
        console.error('[HBS] Summarization API error:', error);
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

export async function performMergeCarry(state, chatId) {
    while (state.buckets.length >= 2) {
        const b2 = state.buckets[state.buckets.length - 1];
        const b1 = state.buckets[state.buckets.length - 2];

        if (b1.level !== b2.level || b1.end !== b2.start) {
            break;
        }

        console.log(`[HBS] Merging buckets: L${b1.level} [${b1.start}-${b1.end}) + [${b2.start}-${b2.end})`);

        state.buckets.pop();
        state.buckets.pop();

        const mergeText = formatMessagesForMerge(b1.summary, b2.summary);
        const result = await callSummarize('merge', mergeText, state.maxSummaryWords, {
            chatId,
            range: [b1.start, b2.end],
        });

        state.buckets.push({
            level: b1.level + 1,
            start: b1.start,
            end: b2.end,
            summary: result.text,
            summaryTokens: result.tokens,
            createdAt: Date.now(),
        });

        console.log(`[HBS] Merged to: L${b1.level + 1} [${b1.start}-${b2.end})`);
    }
}

export async function ensureBucketsUpToDate(state, uaMessages, chatId) {
    const historyEnd = Math.max(0, uaMessages.length - state.keepLastN);

    console.log(`[HBS] Bucket check: processedUntil=${state.processedUntil}, historyEnd=${historyEnd}, total=${uaMessages.length}`);

    while (state.processedUntil + state.base <= historyEnd) {
        const start = state.processedUntil;
        const end = start + state.base;
        const chunk = uaMessages.slice(start, end);

        console.log(`[HBS] Creating leaf bucket: [${start}-${end})`);

        const text = formatMessagesForLeaf(chunk);
        const result = await callSummarize('leaf', text, state.maxSummaryWords, {
            chatId,
            range: [start, end],
        });

        state.buckets.push({
            level: 0,
            start,
            end,
            summary: result.text,
            summaryTokens: result.tokens,
            createdAt: Date.now(),
        });

        state.processedUntil = end;

        await performMergeCarry(state, chatId);
    }

    state.fingerprint = computeFingerprint(uaMessages, historyEnd);
    state.dirty = false;
}

export function buildVirtualChat(state, uaMessages, extensionSettings) {
    const historyEnd = Math.max(0, uaMessages.length - state.keepLastN);
    const virtual = [];

    if (state.buckets.length > 0) {
        const sortedBuckets = state.buckets.slice().sort((a, b) => a.start - b.start);
        const allSummaries = sortedBuckets.map(b => b.summary).join('\n\n');

        const template = extensionSettings.injectionTemplate || '[Summary of earlier conversation:]\n{{summary}}';
        const injectedText = template.replace('{{summary}}', allSummaries);

        virtual.push({
            role: 'system',
            mes: injectedText,
            is_system: true,
            is_user: false,
            name: 'HBS Summary',
        });
    }

    const remainderStart = state.processedUntil;
    for (let i = remainderStart; i < historyEnd; i++) {
        if (i < uaMessages.length) {
            virtual.push(uaMessages[i]);
        }
    }

    for (let i = historyEnd; i < uaMessages.length; i++) {
        virtual.push(uaMessages[i]);
    }

    return virtual;
}

export async function countTokensForMessages(messages) {
    const context = getContext();
    const getTokenCountAsync = context.getTokenCountAsync;

    if (!getTokenCountAsync) {
        console.warn('[HBS] Token counting not available');
        return 0;
    }

    let total = 0;
    for (const msg of messages) {
        if (msg.mes) {
            const count = await getTokenCountAsync(msg.mes, 0);
            total += count;
        }
    }

    return total;
}

export async function computeTokenStats(state, uaMessages) {
    const historyEnd = Math.max(0, uaMessages.length - state.keepLastN);

    let bucketTokens = 0;
    for (const bucket of state.buckets) {
        bucketTokens += bucket.summaryTokens || 0;
    }

    const remainderMessages = uaMessages.slice(state.processedUntil, historyEnd);
    const remainderTokens = await countTokensForMessages(remainderMessages);

    const liveMessages = uaMessages.slice(historyEnd);
    const liveTokens = await countTokensForMessages(liveMessages);

    return {
        bucketTokens,
        remainderTokens,
        liveTokens,
        totalVirtual: bucketTokens + remainderTokens + liveTokens,
        processedUntil: state.processedUntil,
        historyEnd,
        totalMessages: uaMessages.length,
        bucketsCount: state.buckets.length,
    };
}

export function resetHbsState(state) {
    state.processedUntil = 0;
    state.buckets = [];
    state.dirty = false;
    state.fingerprint = '';
}
