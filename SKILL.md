---
name: memory-tools
description: Agent-controlled memory plugin for OpenClaw with confidence scoring, decay, and semantic search. The agent decides WHEN to store/retrieve memories — no auto-capture noise.
homepage: https://github.com/Purple-Horizons/openclaw-memory-tools
metadata:
  openclaw:
    emoji: 🧠
    kind: plugin
    requires:
      env:
        - OPENAI_API_KEY
---

# Memory Tools

Agent-controlled persistent memory for OpenClaw.

## Why Memory-as-Tools?

Traditional memory systems auto-capture everything, flooding context with irrelevant information. Memory Tools follows the [AgeMem](https://arxiv.org/abs/2409.02634) approach: **the agent decides** when to store and retrieve memories.

## Features

- **6 Memory Tools**: `memory_store`, `memory_update`, `memory_forget`, `memory_search`, `memory_summarize`, `memory_list`
- **Confidence Scoring**: Track how certain you are (1.0 = explicit, 0.5 = inferred)
- **Importance Scoring**: Prioritize critical instructions over nice-to-know facts
- **Decay/Expiration**: Temporal memories automatically become stale
- **Semantic Search**: Vector-based similarity via LanceDB
- **Hybrid Storage**: SQLite (debuggable) + LanceDB (fast vectors)
- **Conflict Resolution**: New info auto-supersedes old (no contradictions)

## Installation

```bash
clawhub install memory-tools
```

Then add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "memory-tools": {
        "enabled": true,
        "config": {
          "embedding": {}
        }
      }
    }
  }
}
```

Requires `OPENAI_API_KEY` environment variable for embeddings.

## Memory Categories

| Category | Use For | Example |
|----------|---------|---------|
| fact | Static information | "User's dog is named Rex" |
| preference | Likes/dislikes | "User prefers dark mode" |
| event | Temporal things | "Dentist Tuesday 3pm" |
| instruction | Standing orders | "Always respond in Spanish" |
| decision | Choices made | "We decided to use PostgreSQL" |

## Tool Reference

### memory_store
```
memory_store({
  content: "User prefers bullet points",
  category: "preference",
  confidence: 0.9,
  importance: 0.7
})
```

### memory_search
```
memory_search({
  query: "formatting preferences",
  category: "preference",
  limit: 10
})
```

### memory_forget
```
memory_forget({
  query: "bullet points",
  reason: "User corrected"
})
```

## Debugging

Inspect what your agent knows:
```bash
sqlite3 ~/.openclaw/memory/tools/memory.db "SELECT * FROM memories"
```

## License

MIT — [Purple Horizons](https://github.com/Purple-Horizons)
