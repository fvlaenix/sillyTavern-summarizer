# HBS - Hierarchical Bucket Summarizer for SillyTavern

A powerful SillyTavern extension that uses hierarchical bucketing to compress chat history while preserving recent context. Perfect for long conversations that exceed context limits.

## Features

- **Hierarchical Compression**: Groups messages into exponentially growing buckets (8 → 16 → 32 → 64...)
- **Live Window**: Always keeps the most recent N messages uncompressed
- **Lazy Summarization**: Only summarizes when needed (before generation)
- **Token Tracking**: Real-time statistics on token usage
- **Uses Existing Connections**: Leverages your SillyTavern connection profiles (no duplicate API setup!)
- **Per-Chat Configuration**: Different settings for different chats
- **Dirty Detection**: Warns when old messages are edited
- **Server-Side Storage**: All bucket data persists in chat metadata on the server

## Architecture

HBS is a client-side extension that:
- Stores bucket data in `chat_metadata` (persisted server-side in JSONL files)
- Uses SillyTavern's **Connection Manager** to make LLM calls
- Intercepts generation to replace old messages with hierarchical summaries

**No server plugin needed!** Everything works through existing SillyTavern infrastructure.

## Installation

### Prerequisites

- SillyTavern installation
- At least one configured connection profile in SillyTavern (OpenAI, Kobold, etc.)

### Installation Steps

1. **Install the extension:**

   Clone this repository into your SillyTavern extensions directory:

   ```bash
   cd /path/to/SillyTavern/public/scripts/extensions/third-party/
   git clone <repository_url> sillyTavern-summarizer
   ```

2. **Restart SillyTavern**

3. **Configure HBS:**
   - Open SillyTavern
   - Go to **Extensions** → **HBS - Hierarchical Bucket Summarizer**
   - Select a **Connection Profile** from the dropdown
   - Check "Enable globally" if desired

That's it! No server configuration, no environment variables, no API keys to duplicate.

## Usage

### Initial Setup

1. Open SillyTavern
2. Go to **Extensions** → **HBS - Hierarchical Bucket Summarizer**
3. **Select a connection profile** from the dropdown
   - This can be any existing connection (OpenAI, local LLM, etc.)
   - HBS will use this profile for summarization
   - Your main chat can use a different connection!
4. Check "Enable globally" if desired

### Per-Chat Configuration

For each chat you want to use HBS:

1. Load the chat
2. Go to HBS extension settings
3. Check "Enable for this chat"
4. Adjust settings:
   - **Live window**: Number of recent messages to keep uncompressed (default: 12)
   - **Max summary words**: Maximum words per summary (default: 120)

### How It Works

When you generate a response:

1. HBS filters user/assistant messages
2. Creates buckets for old messages (8 messages per bucket)
3. Merges adjacent same-size buckets (8+8→16, 16+16→32, etc.)
4. Replaces old messages with summaries in the prompt
5. Keeps the live window (last N messages) verbatim
6. **Saves bucket data to chat metadata** (persisted server-side)

### Viewing Statistics

The Statistics panel shows:
- **Total messages**: All user/assistant messages
- **Processed until**: Messages covered by buckets
- **History end**: Where live window starts
- **Token breakdown**: Buckets, remainder, live window
- **Buckets by level**: Count of buckets at each level (L0, L1, L2...)

### Managing Buckets

- **Force Build**: Manually trigger bucket creation without generating
- **Rebuild All**: Clear and re-summarize the entire chat history
- **Reset State**: Delete all buckets and start fresh
- Click bucket items to expand/collapse summaries

## Algorithm Details

### Bucket Sizes

Buckets grow exponentially based on powers of 2:
- Level 0: 8 messages
- Level 1: 16 messages
- Level 2: 32 messages
- Level 3: 64 messages
- etc.

### Merge Logic

When two adjacent buckets of the same level exist, they merge into a higher level:

```
[0-8) L0 + [8-16) L0 → [0-16) L1
[0-16) L1 + [16-32) L1 → [0-32) L2
```

This ensures logarithmic bucket count: O(log N) buckets for N messages.

### Virtual Prompt Structure

The prompt sent to the LLM contains:
1. **Bucket summaries** (as system message by default)
2. **Remainder messages** (not yet bucketed, raw)
3. **Live window** (most recent messages, raw)

Example with 100 messages, keepLastN=12, base=8:
- Buckets cover [0-88): compressed into ~4-5 summaries
- Remainder [88-88): empty (perfectly aligned)
- Live window [88-100): 12 raw messages

## Configuration Reference

### Extension Settings (Global)

| Setting | Default | Description |
|---------|---------|-------------|
| `enabledGlobally` | `true` | Master enable/disable switch |
| `defaultBase` | `8` | Messages per bucket (don't change) |
| `defaultKeepLastN` | `12` | Default live window size |
| `defaultMaxSummaryWords` | `120` | Default max words per summary |
| `selectedProfileId` | `null` | Connection profile for summarization |
| `injectionTemplate` | `[Summary...]` | Template for summary injection |
| `injectionRole` | `system` | Role for summary (system/user/assistant) |

### Per-Chat Settings

| Setting | Description |
|---------|-------------|
| `enabled` | Enable/disable for this chat |
| `keepLastN` | Override live window size |
| `maxSummaryWords` | Override summary word limit |

### Connection Profiles

HBS uses SillyTavern's **Connection Manager** profiles. To create one:

1. Go to **Extensions** → **Connection Manager**
2. Create a new profile or use an existing one
3. Configure the API endpoint, model, presets, etc.
4. Select it in HBS settings

**Recommended setup:**
- Use a fast, cheap model for summarization (e.g., `gpt-4o-mini`)
- Your main chat can use a different, more powerful model
- HBS respects the profile's presets (temperature, top_p, etc.)

## Data Storage

### Where is data stored?

All HBS data is stored **server-side** in SillyTavern:

1. **Bucket data** → `chat_metadata.hbs` in each chat's JSONL file
   - Location: `/data/[user]/chats/[character]/[chat].jsonl`
   - First line of file contains metadata including HBS buckets

2. **Global settings** → `extension_settings.hbs` in settings.json
   - Location: `/data/[user]/settings.json`
   - Contains global preferences and selected profile

**Benefits:**
- Data persists across browser sessions
- Works with chat backups
- No data loss if browser cache is cleared
- Synchronized across devices (if using same server)

## Troubleshooting

### "No connection profile selected"

1. Go to **Extensions** → **Connection Manager**
2. Create or verify you have at least one profile
3. Go to HBS settings and select it from the dropdown

### "Summarization failed"

1. Verify the selected connection profile works in main chat
2. Check browser console (F12) for detailed errors
3. Try selecting a different connection profile
4. Ensure the profile's API endpoint is accessible

### Virtual prompt too large

- Reduce `keepLastN` (live window size)
- Reduce `maxSummaryWords` (summary length)
- Some messages may be too large to fit even with summaries

### Buckets seem wrong after editing messages

This is expected. The "dirty" indicator will appear. Options:
- **Rebuild All**: Re-summarize from scratch
- **Reset State**: Clear all buckets

### Live window alone exceeds context

Your recent messages are too large even before summarization:
- Reduce `keepLastN`
- Shorter recent messages
- Use a model with larger context

## Technical Details

### Why Hierarchical Buckets?

Traditional sliding-window summarization either:
- Loses old context entirely (fixed window)
- Grows linearly with chat length (recursive summarization)

HBS uses a binary tree-like structure where:
- Each level represents 2^k messages
- Total buckets is O(log N) for N messages
- Old context gradually "fades" but never disappears

### Performance

- Summarization calls: O(log N) for N new messages
- Token overhead: ~100-200 tokens per bucket
- For a 1000-message chat: ~7-10 buckets ≈ 1000-2000 summary tokens vs 50,000+ raw tokens

### Connection Manager Integration

HBS uses `ConnectionManagerRequestService.sendRequest()` to:
- Select any configured connection profile
- Automatically apply presets (temperature, top_p, etc.)
- Support both chat completion and text completion APIs
- Work with any provider (OpenAI, Anthropic, local LLMs, etc.)

## File Structure

```
sillyTavern-summarizer/
├── manifest.json     # Extension metadata
├── index.js          # Main logic and UI
├── bucket-manager.js # Bucket algorithms
├── style.css         # UI styles
└── README.md
```

## Advanced Configuration

### Custom Injection Templates

Edit `injectionTemplate` in global settings:

```javascript
extension_settings.hbs.injectionTemplate = "Previous conversation summary:\n{{summary}}";
```

The `{{summary}}` placeholder will be replaced with all bucket summaries.

### Custom Injection Role

Change where summaries appear in the prompt:

- `system` (default): System message role
- `user`: User message role
- `assistant`: Assistant message role

```javascript
extension_settings.hbs.injectionRole = "user";
```

## License

MIT

## Contributing

Issues and pull requests welcome!

## Credits

Designed for the SillyTavern community. Built to integrate seamlessly with SillyTavern's Connection Manager architecture.
