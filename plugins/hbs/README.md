# HBS Server Plugin

This is the server-side plugin for the Hierarchical Bucket Summarizer (HBS) extension.

## Configuration

The plugin requires the following environment variables:

- `HBS_SUMM_BASE_URL` - Base URL of OpenAI-compatible API (e.g., `https://api.openai.com/v1`)
- `HBS_SUMM_API_KEY` - API key for authentication
- `HBS_SUMM_MODEL` - Model name (default: `gpt-4o-mini`)
- `HBS_SUMM_TEMPERATURE` - Temperature for generation (default: `0.3`)
- `HBS_SUMM_MAX_TOKENS` - Maximum response tokens (default: `256`)

## Endpoints

### GET `/api/plugins/hbs/health`

Returns health status and configuration state.

**Response:**
```json
{
  "ok": true,
  "configured": true,
  "model": "gpt-4o-mini",
  "message": "HBS plugin is configured and ready"
}
```

### POST `/api/plugins/hbs/summarize`

Generates a summary using the configured LLM.

**Request:**
```json
{
  "mode": "leaf",
  "text": "U: Hello\nA: Hi there!",
  "maxWords": 120,
  "meta": {
    "chatId": "...",
    "range": [0, 8]
  }
}
```

**Response:**
```json
{
  "success": true,
  "summary": "The user greeted the assistant, who responded warmly.",
  "usage": {
    "prompt_tokens": 45,
    "completion_tokens": 12,
    "total_tokens": 57
  }
}
```

## Installation

1. Copy this directory to `SillyTavern/plugins/hbs/`
2. Enable server plugins in `config.yaml`: `enableServerPlugins: true`
3. Set the required environment variables
4. Restart SillyTavern
