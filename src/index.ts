/**
 * OpenClaw Memory-as-Tools Plugin
 *
 * Agent-controlled memory with confidence scoring, decay, and semantic search.
 * The agent decides WHEN to store/retrieve memories (AgeMem pattern).
 *
 * Key features:
 * - Six memory tools: store, update, forget, search, summarize, list
 * - Hybrid SQLite + LanceDB storage
 * - Confidence scoring (how accurate)
 * - Importance scoring (how critical)
 * - Decay/expiration for temporal memories
 * - Auto-inject standing instructions at conversation start
 */

import type { OpenClawPluginApi } from './plugin-types.js';
import { Type } from '@sinclair/typebox';
import { parseConfig } from './config.js';
import { vectorDimsForModel, MEMORY_CATEGORIES } from './types.js';
import { EmbeddingProvider } from './embeddings.js';
import { MemoryStore } from './store.js';
import { createMemoryTools } from './tools.js';

// System prompt addition to guide agent on memory usage
const MEMORY_SYSTEM_PROMPT = `
## Memory Management

You have access to persistent memory tools. Use them thoughtfully:

**STORE** new memories when:
- User shares personal information (names, dates, preferences)
- User gives standing instructions ("always...", "never...", "I prefer...")
- User mentions relationships ("my wife", "my boss")
- Something would be useful in future conversations

**SEARCH** memories when:
- Starting a new conversation (get context)
- User references the past ("remember when...")
- Personalizing responses
- Before storing (avoid duplicates)

**UPDATE** when information changes or becomes more accurate.

**FORGET** when user requests or info becomes obsolete.

### Guidelines

1. **Be selective** — Don't store everything. Store what matters.
2. **Be atomic** — One fact per memory. "User likes coffee and tea" → two memories.
3. **Be confident** — Use confidence scores honestly:
   - 1.0 = User explicitly stated
   - 0.7-0.9 = User strongly implied
   - 0.5-0.7 = Inferred from context
4. **Use decay** — Events should decay (decayDays). Facts usually shouldn't.
5. **Check first** — Search before storing to avoid duplicates.
`;

// Plugin definition
const memoryToolsPlugin = {
  id: 'memory-tools',
  name: 'Memory Tools',
  description: 'Agent-controlled memory with confidence scoring, decay, and semantic search',
  kind: 'memory' as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath!);
    const model = cfg.embedding.model ?? 'text-embedding-3-small';
    const vectorDim = vectorDimsForModel(model);

    const embeddings = new EmbeddingProvider(cfg.embedding.apiKey, model);
    const store = new MemoryStore(resolvedDbPath, embeddings, vectorDim);
    const tools = createMemoryTools(store);

    api.logger.info(`memory-tools: initialized (db: ${resolvedDbPath}, model: ${model})`);

    // ═══════════════════════════════════════════════════════════════════════
    // Register Tools
    // ═══════════════════════════════════════════════════════════════════════

    api.registerTool(
      {
        name: tools.memory_store.name,
        label: tools.memory_store.label,
        description: tools.memory_store.description,
        parameters: tools.memory_store.parameters,
        execute: (id, params) => tools.memory_store.execute(id, params as any, {}),
      },
      { name: 'memory_store' }
    );

    api.registerTool(
      {
        name: tools.memory_update.name,
        label: tools.memory_update.label,
        description: tools.memory_update.description,
        parameters: tools.memory_update.parameters,
        execute: (id, params) => tools.memory_update.execute(id, params as any),
      },
      { name: 'memory_update' }
    );

    api.registerTool(
      {
        name: tools.memory_forget.name,
        label: tools.memory_forget.label,
        description: tools.memory_forget.description,
        parameters: tools.memory_forget.parameters,
        execute: (id, params) => tools.memory_forget.execute(id, params as any),
      },
      { name: 'memory_forget' }
    );

    api.registerTool(
      {
        name: tools.memory_search.name,
        label: tools.memory_search.label,
        description: tools.memory_search.description,
        parameters: tools.memory_search.parameters,
        execute: (id, params) => tools.memory_search.execute(id, params as any),
      },
      { name: 'memory_search' }
    );

    api.registerTool(
      {
        name: tools.memory_summarize.name,
        label: tools.memory_summarize.label,
        description: tools.memory_summarize.description,
        parameters: tools.memory_summarize.parameters,
        execute: (id, params) => tools.memory_summarize.execute(id, params as any),
      },
      { name: 'memory_summarize' }
    );

    api.registerTool(
      {
        name: tools.memory_list.name,
        label: tools.memory_list.label,
        description: tools.memory_list.description,
        parameters: tools.memory_list.parameters,
        execute: (id, params) => tools.memory_list.execute(id, params as any),
      },
      { name: 'memory_list' }
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Lifecycle Hooks
    // ═══════════════════════════════════════════════════════════════════════

    // Auto-inject standing instructions at conversation start
    if (cfg.autoInjectInstructions !== false) {
      api.on('before_agent_start', async (event: { prompt?: string }) => {
        // Get standing instructions
        const instructions = store.getByCategory('instruction', 10);

        if (instructions.length === 0) {
          return { systemPrompt: MEMORY_SYSTEM_PROMPT };
        }

        const instructionList = instructions
          .map(m => `- ${m.content}`)
          .join('\n');

        api.logger.info?.(`memory-tools: injecting ${instructions.length} standing instructions`);

        return {
          systemPrompt: MEMORY_SYSTEM_PROMPT,
          prependContext: `<standing-instructions>\nRemember these user instructions:\n${instructionList}\n</standing-instructions>`,
        };
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CLI Commands
    // ═══════════════════════════════════════════════════════════════════════

    api.registerCli(
      ({ program }: { program: any }) => {
        const memory = program
          .command('memory-tools')
          .description('Memory-as-Tools plugin commands');

        memory
          .command('stats')
          .description('Show memory statistics')
          .action(() => {
            const total = store.count();
            const instructions = store.getByCategory('instruction').length;
            const facts = store.getByCategory('fact').length;
            const preferences = store.getByCategory('preference').length;

            console.log(`Memory Statistics:`);
            console.log(`  Total: ${total}`);
            console.log(`  Instructions: ${instructions}`);
            console.log(`  Facts: ${facts}`);
            console.log(`  Preferences: ${preferences}`);
          });

        memory
          .command('list')
          .description('List memories')
          .option('-c, --category <category>', 'Filter by category')
          .option('-l, --limit <n>', 'Max results', '20')
          .action((opts: { category?: string; limit?: string }) => {
            const results = store.list({
              category: opts.category as any,
              limit: parseInt(opts.limit ?? '20'),
            });

            console.log(`Showing ${results.items.length} of ${results.total} memories:\n`);
            for (const m of results.items) {
              console.log(`[${m.id.slice(0, 8)}] [${m.category}] ${m.content.slice(0, 60)}...`);
            }
          });

        memory
          .command('search <query>')
          .description('Search memories')
          .option('-l, --limit <n>', 'Max results', '10')
          .action(async (query: string, opts: { limit?: string }) => {
            const results = await store.search({
              query,
              limit: parseInt(opts.limit ?? '10'),
            });

            console.log(`Found ${results.length} memories:\n`);
            for (const r of results) {
              console.log(`[${r.memory.id.slice(0, 8)}] (${(r.score * 100).toFixed(0)}%) ${r.memory.content}`);
            }
          });

        memory
          .command('export')
          .description('Export all memories as JSON')
          .action(() => {
            const results = store.list({ limit: 10000 });
            console.log(JSON.stringify(results.items, null, 2));
          });
      },
      { commands: ['memory-tools'] }
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Service (lifecycle management)
    // ═══════════════════════════════════════════════════════════════════════

    api.registerService({
      id: 'memory-tools',
      start: () => {
        api.logger.info(`memory-tools: service started (${store.count()} memories)`);
      },
      stop: () => {
        store.close();
        api.logger.info('memory-tools: service stopped');
      },
    });
  },
};

export default memoryToolsPlugin;

// Re-export types for external use
export * from './types.js';
export { MemoryStore } from './store.js';
export { EmbeddingProvider } from './embeddings.js';
export { createMemoryTools } from './tools.js';
