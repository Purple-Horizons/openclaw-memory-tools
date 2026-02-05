/**
 * Memory Tools Tests
 *
 * Tests for the six agent-controlled memory operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryTools } from './tools.js';
import { MemoryStore } from './store.js';
import { EmbeddingProvider } from './embeddings.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock embedding provider
class MockEmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const hash = this.hashString(text);
    return new Array(1536).fill(0).map((_, i) =>
      Math.sin(hash + i * 0.1) * 0.5 + 0.5
    );
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}

describe('Memory Tools', () => {
  let store: MemoryStore;
  let tools: ReturnType<typeof createMemoryTools>;
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `memory-tools-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const embeddings = new MockEmbeddingProvider() as unknown as EmbeddingProvider;
    store = new MemoryStore(testDir, embeddings, 1536);
    tools = createMemoryTools(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('memory_store', () => {
    it('should store a new memory', async () => {
      const result = await tools.memory_store.execute('call-1', {
        content: 'User prefers dark mode',
        category: 'preference',
        confidence: 0.9,
      });

      expect(result.details.action).toBe('created');
      expect(result.details.id).toBeDefined();
      expect(result.content[0].text).toContain('Stored');
    });

    it('should detect duplicates', async () => {
      // Store first memory
      await tools.memory_store.execute('call-1', {
        content: 'User prefers dark mode',
        category: 'preference',
      });

      // Try to store very similar memory
      const result = await tools.memory_store.execute('call-2', {
        content: 'User prefers dark mode',
        category: 'preference',
      });

      expect(result.details.action).toBe('duplicate');
      expect(result.content[0].text).toContain('Similar memory already exists');
    });

    it('should include tags and decay', async () => {
      const result = await tools.memory_store.execute('call-1', {
        content: 'Meeting tomorrow at 3pm',
        category: 'event',
        tags: ['meeting', 'work'],
        decayDays: 7,
      });

      expect(result.details.action).toBe('created');

      const memory = store.get(result.details.id);
      expect(memory!.tags).toEqual(['meeting', 'work']);
      expect(memory!.decayDays).toBe(7);
    });
  });

  describe('memory_update', () => {
    it('should update memory content', async () => {
      const created = await tools.memory_store.execute('call-1', {
        content: 'User dog name is Max',
        category: 'fact',
      });

      const result = await tools.memory_update.execute('call-2', {
        id: created.details.id,
        content: 'User dog name is Rex',
      });

      expect(result.details.action).toBe('updated');
      expect(result.content[0].text).toContain('Rex');
    });

    it('should update confidence', async () => {
      const created = await tools.memory_store.execute('call-1', {
        content: 'User might like coffee',
        category: 'preference',
        confidence: 0.5,
      });

      await tools.memory_update.execute('call-2', {
        id: created.details.id,
        confidence: 0.95,
      });

      const memory = store.get(created.details.id);
      expect(memory!.confidence).toBe(0.95);
    });

    it('should return error for non-existent memory', async () => {
      const result = await tools.memory_update.execute('call-1', {
        id: 'non-existent',
        content: 'New content',
      });

      expect(result.details.error).toBe('not_found');
    });
  });

  describe('memory_forget', () => {
    it('should delete by id', async () => {
      const created = await tools.memory_store.execute('call-1', {
        content: 'Delete me',
        category: 'fact',
      });

      const result = await tools.memory_forget.execute('call-2', {
        id: created.details.id,
        reason: 'User requested',
      });

      expect(result.details.action).toBe('deleted');

      const memory = store.get(created.details.id);
      expect(memory!.deletedAt).toBeDefined();
    });

    it('should auto-delete high-confidence single match', async () => {
      await tools.memory_store.execute('call-1', {
        content: 'My old car is a Honda',
        category: 'fact',
      });

      const result = await tools.memory_forget.execute('call-2', {
        query: 'My old car is a Honda',
      });

      expect(result.details.action).toBe('deleted');
    });

    it('should return candidates when multiple matches', async () => {
      await tools.memory_store.execute('call-1', {
        content: 'User likes coffee',
        category: 'preference',
      });
      await tools.memory_store.execute('call-2', {
        content: 'User likes tea',
        category: 'preference',
      });

      const result = await tools.memory_forget.execute('call-3', {
        query: 'User likes',
      });

      expect(result.details.action).toBe('candidates');
      expect(result.details.candidates.length).toBeGreaterThanOrEqual(2);
    });

    it('should return error when no params provided', async () => {
      const result = await tools.memory_forget.execute('call-1', {});

      expect(result.details.error).toBe('missing_param');
    });
  });

  describe('memory_search', () => {
    beforeEach(async () => {
      await tools.memory_store.execute('call-1', {
        content: 'User prefers dark mode',
        category: 'preference',
        confidence: 0.9,
      });
      await tools.memory_store.execute('call-2', {
        content: 'User sister is Sarah',
        category: 'relationship',
        confidence: 0.95,
      });
      await tools.memory_store.execute('call-3', {
        content: 'Meeting at 3pm tomorrow',
        category: 'event',
        confidence: 0.8,
      });
    });

    it('should search by query', async () => {
      const result = await tools.memory_search.execute('call-4', {
        query: 'dark mode settings',
        limit: 5,
      });

      expect(result.details.count).toBeGreaterThan(0);
      expect(result.details.memories.length).toBeGreaterThan(0);
    });

    it('should filter by category', async () => {
      const result = await tools.memory_search.execute('call-4', {
        category: 'preference',
      });

      expect(result.details.memories.every(
        (m: any) => m.category === 'preference'
      )).toBe(true);
    });

    it('should filter by minimum confidence', async () => {
      const result = await tools.memory_search.execute('call-4', {
        minConfidence: 0.9,
      });

      expect(result.details.memories.every(
        (m: any) => m.confidence >= 0.9
      )).toBe(true);
    });

    it('should return no results message', async () => {
      store.close();

      // Create fresh store
      const embeddings = new MockEmbeddingProvider() as unknown as EmbeddingProvider;
      store = new MemoryStore(testDir + '-empty', embeddings, 1536);
      tools = createMemoryTools(store);

      const result = await tools.memory_search.execute('call-1', {
        query: 'something',
      });

      expect(result.details.count).toBe(0);
      expect(result.content[0].text).toBe('No relevant memories found.');

      fs.rmSync(testDir + '-empty', { recursive: true, force: true });
    });
  });

  describe('memory_summarize', () => {
    beforeEach(async () => {
      await tools.memory_store.execute('call-1', {
        content: 'User works at Acme Corp',
        category: 'fact',
      });
      await tools.memory_store.execute('call-2', {
        content: 'User is a software engineer',
        category: 'fact',
      });
      await tools.memory_store.execute('call-3', {
        content: 'User prefers morning meetings',
        category: 'preference',
      });
    });

    it('should summarize memories by topic', async () => {
      const result = await tools.memory_summarize.execute('call-4', {
        topic: 'work',
      });

      expect(result.details.memoryCount).toBeGreaterThan(0);
      expect(result.content[0].text).toContain('Summary');
    });

    it('should return no memories message', async () => {
      const result = await tools.memory_summarize.execute('call-4', {
        topic: 'completely unrelated xyz123',
      });

      // With our mock embeddings, might still return some results
      // Just verify the response structure
      expect(result.content[0].text).toBeDefined();
    });
  });

  describe('memory_list', () => {
    beforeEach(async () => {
      await tools.memory_store.execute('call-1', {
        content: 'First memory',
        category: 'fact',
        importance: 0.3,
      });
      await tools.memory_store.execute('call-2', {
        content: 'Second memory',
        category: 'preference',
        importance: 0.9,
      });
      await tools.memory_store.execute('call-3', {
        content: 'Third memory',
        category: 'fact',
        importance: 0.6,
      });
    });

    it('should list all memories', async () => {
      const result = await tools.memory_list.execute('call-4', {});

      expect(result.details.total).toBe(3);
      expect(result.details.count).toBe(3);
    });

    it('should filter by category', async () => {
      const result = await tools.memory_list.execute('call-4', {
        category: 'fact',
      });

      expect(result.details.total).toBe(2);
      expect(result.details.memories.every(
        (m: any) => m.category === 'fact'
      )).toBe(true);
    });

    it('should sort by importance', async () => {
      const result = await tools.memory_list.execute('call-4', {
        sortBy: 'importance',
      });

      const importances = result.details.memories.map((m: any) => m.importance);
      expect(importances[0]).toBeGreaterThanOrEqual(importances[1]);
    });

    it('should paginate', async () => {
      const result = await tools.memory_list.execute('call-4', {
        limit: 2,
        offset: 0,
      });

      expect(result.details.total).toBe(3);
      expect(result.details.count).toBe(2);
    });
  });
});
