# CLAUDE.md

Project context for Claude Code.

## Project

**memory-tools** - Agent-controlled memory plugin for OpenClaw/ClawHub.

- **Repo**: `Purple-Horizons/memory-tools`
- **ClawHub slug**: `memory-tools`
- **Owner**: gianni-dalerta

## Architecture

- **SQLite via sql.js (WASM)** - No native compilation, works on any Node version
- **LanceDB** - Vector storage for semantic search
- **Hybrid storage** - Metadata in SQLite, embeddings in LanceDB

## Key Decisions

- Switched from `better-sqlite3` to `sql.js` (v1.1.0) to eliminate `NODE_MODULE_VERSION` mismatch errors when users have different Node.js versions
- Database initialization is async (WASM loading), so sync methods require `await store.init()` first

## Publishing to ClawHub

```bash
clawhub publish . --slug memory-tools --version X.Y.Z --changelog "description"
```

Always use `--slug memory-tools` to update the correct skill.

## Build & Test

```bash
npm run build    # TypeScript compile
npm test         # Run vitest
```
