import express from 'express';

export const info = {
    id: 'hbs',
    name: 'HBS - Hierarchical Bucket Summarizer',
    description: 'Provides summarization endpoints for HBS extension',
};

let config = {
    baseUrl: process.env.HBS_SUMM_BASE_URL || '',
    apiKey: process.env.HBS_SUMM_API_KEY || '',
    model: process.env.HBS_SUMM_MODEL || 'gpt-4o-mini',
    temperature: parseFloat(process.env.HBS_SUMM_TEMPERATURE || '0.3'),
    maxTokens: parseInt(process.env.HBS_SUMM_MAX_TOKENS || '256', 10),
};

const LEAF_SYSTEM_PROMPT = `You are a precise summarizer. Summarize the following conversation excerpt.
Focus on: key facts, character actions, plot developments, emotional states.
Output only the summary, no preamble or meta-commentary.`;

const MERGE_SYSTEM_PROMPT = `You are a precise summarizer. Merge these two consecutive summaries into one cohesive summary.
Preserve chronological order and key information from both.
Output only the merged summary, no preamble or meta-commentary.`;

function isConfigured() {
    return config.baseUrl && config.apiKey && config.model;
}

async function callOpenAICompatibleAPI(messages, maxWords) {
    if (!isConfigured()) {
        throw new Error('HBS plugin not configured. Set environment variables: HBS_SUMM_BASE_URL, HBS_SUMM_API_KEY, HBS_SUMM_MODEL');
    }

    const url = `${config.baseUrl}/chat/completions`;

    const requestBody = {
        model: config.model,
        messages: messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();

        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Invalid API response format');
        }

        return {
            summary: data.choices[0].message.content.trim(),
            usage: data.usage || null,
        };
    } catch (error) {
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
            throw new Error('API request timed out after 30 seconds');
        }
        throw error;
    }
}

async function summarizeLeaf(text, maxWords) {
    const userPrompt = `Summarize the following conversation in under ${maxWords} words:\n\n${text}`;

    const messages = [
        { role: 'system', content: LEAF_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
    ];

    return await callOpenAICompatibleAPI(messages, maxWords);
}

async function summarizeMerge(text, maxWords) {
    const userPrompt = `Merge these summaries into one summary under ${maxWords} words:\n\n${text}`;

    const messages = [
        { role: 'system', content: MERGE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
    ];

    return await callOpenAICompatibleAPI(messages, maxWords);
}

export async function init(router) {
    console.log('[HBS] Initializing plugin...');
    console.log('[HBS] Configuration:');
    console.log(`  Base URL: ${config.baseUrl || '(not set)'}`);
    console.log(`  API Key: ${config.apiKey ? '(set)' : '(not set)'}`);
    console.log(`  Model: ${config.model}`);
    console.log(`  Temperature: ${config.temperature}`);
    console.log(`  Max Tokens: ${config.maxTokens}`);

    router.get('/health', (req, res) => {
        const configured = isConfigured();
        res.json({
            ok: true,
            configured: configured,
            model: config.model,
            message: configured
                ? 'HBS plugin is configured and ready'
                : 'HBS plugin not configured. Set HBS_SUMM_BASE_URL, HBS_SUMM_API_KEY, and HBS_SUMM_MODEL environment variables',
        });
    });

    router.post('/summarize', async (req, res) => {
        try {
            const { mode, text, maxWords, meta } = req.body;

            if (!mode || !['leaf', 'merge'].includes(mode)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid mode. Must be "leaf" or "merge"',
                });
            }

            if (!text || typeof text !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: 'Missing or invalid text parameter',
                });
            }

            const words = maxWords || 120;

            console.log(`[HBS] Summarization request: mode=${mode}, maxWords=${words}, textLength=${text.length}`);
            if (meta) {
                console.log(`[HBS] Meta:`, meta);
            }

            let result;
            if (mode === 'leaf') {
                result = await summarizeLeaf(text, words);
            } else {
                result = await summarizeMerge(text, words);
            }

            console.log(`[HBS] Summary generated: ${result.summary.length} characters`);

            res.json({
                success: true,
                summary: result.summary,
                usage: result.usage,
            });
        } catch (error) {
            console.error('[HBS] Summarization error:', error);
            res.status(500).json({
                success: false,
                error: error.message || 'Internal server error',
            });
        }
    });

    console.log('[HBS] Plugin initialized successfully');
}

export async function exit() {
    console.log('[HBS] Plugin shutting down');
}
