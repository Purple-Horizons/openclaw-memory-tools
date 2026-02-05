# OpenClaw Memory Tools

Agent-controlled memory plugin for OpenClaw with confidence scoring, decay, and semantic search.

## Why Memory-as-Tools?

Traditional AI memory systems auto-capture everything, flooding context with irrelevant information. **Memory-as-Tools** follows the [AgeMem](https://arxiv.org/abs/2409.02634) approach: the agent decides **when** to store and retrieve memories.

```
Traditional: Agent → always retrieves → context flooded
Memory-as-Tools: Agent → decides IF/WHAT to remember → uses tools explicitly
```

## Features

- **6 Memory Tools**: `memory_store`, `memory_update`, `memory_forget`, `memory_search`, `memory_summarize`, `memory_list`
- **Confidence Scoring**: Track how certain you are about each memory (1.0 = explicit, 0.5 = inferred)
- **Importance Scoring**: Prioritize critical instructions over nice-to-know facts
- **Decay/Expiration**: Temporal memories (events) automatically become stale
- **Semantic Search**: Vector-based similarity search via LanceDB
- **Hybrid Storage**: SQLite for metadata (debuggable) + LanceDB for vectors (fast)
- **Standing Instructions**: Auto-inject category="instruction" memories at conversation start

## Installation

```bash
# Clone the repo
git clone https://github.com/purple-horizons/openclaw-memory-tools.git
cd openclaw-memory-tools

# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test
```

## Configuration

Add to your OpenClaw configuration (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "memory-tools": {
        "enabled": true,
        "source": "/path/to/openclaw-memory-tools",
        "config": {
          "embedding": {
            "apiKey": "${OPENAI_API_KEY}",
            "model": "text-embedding-3-small"
          },
          "dbPath": "~/.openclaw/memory/tools",
          "autoInjectInstructions": true
        }
      }
    }
  }
}
```

## Memory Categories

| Category | Use For | Example |
|----------|---------|---------|
| `fact` | Static information | "User's dog is named Rex" |
| `preference` | Likes/dislikes | "User prefers dark mode" |
| `event` | Temporal things | "Dentist appointment Tuesday 3pm" |
| `relationship` | People connections | "User's sister is Sarah" |
| `context` | Current work | "Working on React project" |
| `instruction` | Standing orders | "Always respond in Spanish" |
| `decision` | Choices made | "We decided to use PostgreSQL" |
| `entity` | Contact info | "User's email is x@y.com" |

## Tool Reference

### memory_store

Store a new memory.

```typescript
memory_store({
  content: "User prefers bullet points",
  category: "preference",
  confidence: 0.9,      // How sure (0-1)
  importance: 0.7,      // How critical (0-1)
  decayDays: null,      // null = permanent
  tags: ["formatting"]
})
```

### memory_update

Update an existing memory.

```typescript
memory_update({
  id: "abc-123",
  content: "User prefers numbered lists",  // Optional
  confidence: 0.95                          // Optional
})
```

### memory_forget

Delete a memory.

```typescript
memory_forget({
  id: "abc-123",           // If known
  query: "bullet points",  // Or search
  reason: "User corrected"
})
```

### memory_search

Semantic search.

```typescript
memory_search({
  query: "formatting preferences",
  category: "preference",      // Optional filter
  minConfidence: 0.7,          // Optional filter
  limit: 10
})
```

### memory_summarize

Get topic summary.

```typescript
memory_summarize({
  topic: "user's work",
  maxMemories: 20
})
```

### memory_list

Browse all memories.

```typescript
memory_list({
  category: "instruction",
  sortBy: "importance",
  limit: 20
})
```

## CLI Commands

```bash
# Show statistics
openclaw memory-tools stats

# List memories
openclaw memory-tools list --category preference

# Search memories
openclaw memory-tools search "dark mode"

# Export all memories as JSON
openclaw memory-tools export
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Agent                        │
│                                                         │
│  Agent decides: "This is worth remembering"             │
│         ↓                                               │
│  Calls: memory_store(...)                               │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                   Memory Tools                          │
├─────────────────────────────────────────────────────────┤
│  store │ update │ forget │ search │ summarize │ list   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                 Storage Layer                           │
│  ┌──────────────┐    ┌──────────────┐                  │
│  │   SQLite     │    │   LanceDB    │                  │
│  │  (metadata)  │◄──►│  (vectors)   │                  │
│  └──────────────┘    └──────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Type check
pnpm typecheck

# Build
pnpm build
```

## References

- [AgeMem Paper](https://arxiv.org/abs/2409.02634) - Memory operations as first-class tools
- [Mem0](https://github.com/mem0ai/mem0) - AI memory layer
- [OpenClaw](https://github.com/openclaw/openclaw) - Personal AI assistant

## License

MIT - Purple Horizons
