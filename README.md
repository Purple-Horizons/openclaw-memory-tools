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

### Quick Install

```bash
# Clone to OpenClaw extensions directory
git clone https://github.com/purple-horizons/openclaw-memory-tools.git ~/.openclaw/extensions/memory-tools
cd ~/.openclaw/extensions/memory-tools

# Install dependencies and build
pnpm install && pnpm build
```

### Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-tools"
    },
    "entries": {
      "memory-tools": {
        "enabled": true,
        "config": {
          "embedding": {}
        }
      }
    }
  },
  "tools": {
    "alsoAllow": ["group:plugins"]
  }
}
```

### OpenAI API Key

The plugin needs an OpenAI API key for embeddings. Three options:

**Option 1: Environment variable (recommended)**
```bash
# Add to ~/.zshrc or ~/.bashrc
export OPENAI_API_KEY="sk-proj-..."
```

**Option 2: Reference env var in config**
```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}"
  }
}
```

**Option 3: Direct in config (not recommended)**
```json
{
  "embedding": {
    "apiKey": "sk-proj-..."
  }
}
```

### Verify Installation

```bash
# Restart gateway
openclaw gateway stop && openclaw gateway run

# Check plugin loaded
openclaw plugins list

# Test CLI
openclaw memory-tools stats
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

## Comparison with Other Memory Systems

| Feature | [memU](https://github.com/NevaMind-AI/memU) | [claude-mem](https://github.com/thedotmack/claude-mem) | **memory-tools** |
|---------|------|------------|--------------|
| **Architecture** | 3-tier hierarchical (Resource → Item → Category) | Hook-based observer with lifecycle events | Tool-based agent control |
| **Storage Trigger** | Automatic extraction during background processing | Lifecycle hooks (SessionStart, PostToolUse, etc.) | Agent explicitly decides when to store |
| **Conflict Handling** | None - relies on proactive pattern detection | None - auto-capture model | Auto-supersede + explicit forget |
| **Context Injection** | Proactive - predicts and pre-loads context | Progressive disclosure (3-layer filtering) | On-demand via memory_search |
| **Token Efficiency** | Compression via fact extraction | ~10x savings via progressive disclosure | Semantic search with configurable limits |
| **Auditability** | Background processing | Hook-based capture | Full SQLite inspection, explicit tool calls |
| **User Corrections** | Accumulates conflicting facts | Accumulates conflicting facts | Replaces old with new automatically |
| **Best For** | 24/7 agents with predictable patterns | Automatic session continuity | Personal assistants with ongoing relationships |

### Design Philosophy

Different memory systems optimize for different things:

- **Automatic systems** (memU, claude-mem) minimize agent cognitive load by extracting memories in the background. Trade-off: less control over what's captured, conflicts accumulate.

- **Agent-controlled systems** (memory-tools) put the agent in charge of what matters. Trade-off: requires active management, but memories are deliberate choices.

For agents that maintain ongoing relationships with users—where someone might say "no, my favorite color is purple, not blue"—explicit conflict handling prevents contradictory memories from accumulating. Every memory has a clear provenance: the agent decided it was worth remembering, and corrections replace rather than compete with old information.

The hybrid SQLite + LanceDB storage means you can always `sqlite3 ~/.openclaw/memory/tools/memory.db` to inspect exactly what your agent knows and why.

## References

- [AgeMem Paper](https://arxiv.org/abs/2409.02634) - Memory operations as first-class tools
- [memU](https://github.com/NevaMind-AI/memU) - Hierarchical memory with proactive context
- [claude-mem](https://github.com/thedotmack/claude-mem) - Hook-based automatic memory
- [Mem0](https://github.com/mem0ai/mem0) - AI memory layer
- [OpenClaw](https://github.com/openclaw/openclaw) - Personal AI assistant

## License

MIT - [Purple Horizons](https://github.com/Purple-Horizons)
