/**
 * Memory Store Tests
 *
 * Tests for hybrid SQLite + LanceDB storage layer.
 * Uses mocked embeddings to avoid API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from './store.js';
import { EmbeddingProvider } from './embeddings.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock embedding provider
class MockEmbeddingProvider {
  private counter = 0;

  async embed(text: string): Promise<number[]> {
    // Generate deterministic pseudo-random vector based on text hash
    const hash = this.hashString(text);
    const vector = new Array(1536).fill(0).map((_, i) =>
      Math.sin(hash + i * 0.1) * 0.5 + 0.5
    );
    return vector;
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

describe('MemoryStore', () => {
  let store: MemoryStore;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `memory-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    const embeddings = new MockEmbeddingProvider() as unknown as EmbeddingProvider;
    store = new MemoryStore(testDir, embeddings, 1536);
    await store.init(); // Initialize sql.js WASM before tests
  });

  afterEach(() => {
    store.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a memory with all fields', async () => {
      const memory = await store.create({
        content: 'User prefers dark mode',
        category: 'preference',
        confidence: 0.9,
        importance: 0.7,
        tags: ['ui', 'settings'],
      });

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('User prefers dark mode');
      expect(memory.category).toBe('preference');
      expect(memory.confidence).toBe(0.9);
      expect(memory.importance).toBe(0.7);
      expect(memory.tags).toEqual(['ui', 'settings']);
      expect(memory.createdAt).toBeGreaterThan(0);
      expect(memory.deletedAt).toBeUndefined();
    });

    it('should use default values', async () => {
      const memory = await store.create({
        content: 'Test memory',
        category: 'fact',
      });

      expect(memory.confidence).toBe(0.8);
      expect(memory.importance).toBe(0.5);
      expect(memory.tags).toEqual([]);
    });

    it('should support decay days', async () => {
      const memory = await store.create({
        content: 'Meeting tomorrow',
        category: 'event',
        decayDays: 7,
      });

      expect(memory.decayDays).toBe(7);
    });
  });

  describe('get', () => {
    it('should retrieve a memory by id', async () => {
      const created = await store.create({
        content: 'Test content',
        category: 'fact',
      });

      const retrieved = store.get(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.content).toBe('Test content');
    });

    it('should return null for non-existent id', () => {
      const result = store.get('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update content', async () => {
      const memory = await store.create({
        content: 'Original content',
        category: 'fact',
      });

      const updated = await store.update(memory.id, {
        content: 'Updated content',
      });

      expect(updated.content).toBe('Updated content');
      expect(updated.updatedAt).toBeGreaterThan(memory.updatedAt);
    });

    it('should update confidence and importance', async () => {
      const memory = await store.create({
        content: 'Test',
        category: 'fact',
        confidence: 0.5,
        importance: 0.3,
      });

      const updated = await store.update(memory.id, {
        confidence: 0.9,
        importance: 0.8,
      });

      expect(updated.confidence).toBe(0.9);
      expect(updated.importance).toBe(0.8);
    });

    it('should update tags', async () => {
      const memory = await store.create({
        content: 'Test',
        category: 'fact',
        tags: ['old'],
      });

      const updated = await store.update(memory.id, {
        tags: ['new', 'tags'],
      });

      expect(updated.tags).toEqual(['new', 'tags']);
    });
  });

  describe('delete', () => {
    it('should soft delete a memory', async () => {
      const memory = await store.create({
        content: 'To be deleted',
        category: 'fact',
      });

      await store.delete(memory.id, 'Test deletion');

      const retrieved = store.get(memory.id);
      expect(retrieved!.deletedAt).toBeDefined();
      expect(retrieved!.deleteReason).toBe('Test deletion');
    });

    it('should delete using short ID (first 8 chars)', async () => {
      const memory = await store.create({
        content: 'Delete with short ID',
        category: 'fact',
      });

      const shortId = memory.id.slice(0, 8);
      await store.delete(shortId, 'Short ID deletion');

      const retrieved = store.get(memory.id);
      expect(retrieved!.deletedAt).toBeDefined();
    });

    it('should get using short ID (first 8 chars)', async () => {
      const memory = await store.create({
        content: 'Get with short ID',
        category: 'fact',
      });

      const shortId = memory.id.slice(0, 8);
      const retrieved = store.get(shortId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(memory.id);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await store.create({
        content: 'User loves coffee',
        category: 'preference',
        confidence: 0.9,
      });
      await store.create({
        content: 'User hates tea',
        category: 'preference',
        confidence: 0.8,
      });
      await store.create({
        content: 'Meeting at 3pm',
        category: 'event',
        confidence: 0.95,
      });
    });

    it('should search by semantic query', async () => {
      const results = await store.search({
        query: 'coffee preference',
        limit: 5,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('should filter by category', async () => {
      const results = await store.search({
        category: 'preference',
        limit: 10,
      });

      expect(results.every(r => r.memory.category === 'preference')).toBe(true);
    });

    it('should filter by minimum confidence', async () => {
      const results = await store.search({
        minConfidence: 0.85,
        limit: 10,
      });

      expect(results.every(r => r.memory.confidence >= 0.85)).toBe(true);
    });

    it('should respect limit', async () => {
      const results = await store.search({
        limit: 1,
      });

      expect(results.length).toBe(1);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await store.create({ content: 'First', category: 'fact', importance: 0.3 });
      await store.create({ content: 'Second', category: 'fact', importance: 0.9 });
      await store.create({ content: 'Third', category: 'preference', importance: 0.5 });
    });

    it('should list all memories', () => {
      const results = store.list();

      expect(results.total).toBe(3);
      expect(results.items.length).toBe(3);
    });

    it('should filter by category', () => {
      const results = store.list({ category: 'fact' });

      expect(results.total).toBe(2);
      expect(results.items.every(m => m.category === 'fact')).toBe(true);
    });

    it('should sort by importance', () => {
      const results = store.list({ sortBy: 'importance', sortOrder: 'desc' });

      expect(results.items[0].importance).toBeGreaterThanOrEqual(results.items[1].importance);
    });

    it('should paginate', () => {
      const page1 = store.list({ limit: 2, offset: 0 });
      const page2 = store.list({ limit: 2, offset: 2 });

      expect(page1.items.length).toBe(2);
      expect(page2.items.length).toBe(1);
    });
  });

  describe('findDuplicates', () => {
    it('should find similar memories', async () => {
      await store.create({
        content: 'User prefers dark mode',
        category: 'preference',
      });

      const duplicates = await store.findDuplicates('User likes dark mode', 0.5);

      expect(duplicates.length).toBe(1);
      expect(duplicates[0].memory.content).toBe('User prefers dark mode');
    });

    it('should return empty for dissimilar content', async () => {
      await store.create({
        content: 'User prefers dark mode',
        category: 'preference',
      });

      const duplicates = await store.findDuplicates('Meeting tomorrow at 3pm', 0.95);

      expect(duplicates.length).toBe(0);
    });
  });

  describe('count', () => {
    it('should count all non-deleted memories', async () => {
      expect(store.count()).toBe(0);

      await store.create({ content: 'First', category: 'fact' });
      await store.create({ content: 'Second', category: 'fact' });

      expect(store.count()).toBe(2);

      const m = await store.create({ content: 'Third', category: 'fact' });
      await store.delete(m.id);

      expect(store.count()).toBe(2);
    });
  });

  describe('getByCategory', () => {
    it('should get memories by category sorted by importance', async () => {
      await store.create({ content: 'Low', category: 'instruction', importance: 0.3 });
      await store.create({ content: 'High', category: 'instruction', importance: 0.9 });
      await store.create({ content: 'Medium', category: 'instruction', importance: 0.6 });
      await store.create({ content: 'Other', category: 'fact', importance: 1.0 });

      const results = store.getByCategory('instruction');

      expect(results.length).toBe(3);
      expect(results[0].content).toBe('High');
      expect(results[1].content).toBe('Medium');
      expect(results[2].content).toBe('Low');
    });
  });

  describe('touchMany', () => {
    it('should update lastAccessedAt for multiple memories', async () => {
      const m1 = await store.create({ content: 'First', category: 'fact' });
      const m2 = await store.create({ content: 'Second', category: 'fact' });

      const originalAccess = store.get(m1.id)!.lastAccessedAt;

      // Wait a bit to ensure timestamp changes
      await new Promise(resolve => setTimeout(resolve, 10));

      store.touchMany([m1.id, m2.id]);

      const updated = store.get(m1.id)!;
      expect(updated.lastAccessedAt).toBeGreaterThan(originalAccess);
    });
  });

  describe('close and reopen', () => {
    it('should allow database to be reopened after close (SIGUSR1 restart scenario)', async () => {
      // Create a memory before close
      const memory = await store.create({
        content: 'Persistent memory',
        category: 'fact',
        importance: 0.8,
      });

      // Close the database (simulates service stop)
      store.close();

      // Reopen by calling an async method (simulates service restart)
      // This should re-initialize both SQLite and LanceDB
      await store.init();

      // Verify we can still read the persisted memory
      const retrieved = store.get(memory.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.content).toBe('Persistent memory');

      // Verify we can create new memories
      const newMemory = await store.create({
        content: 'New memory after restart',
        category: 'fact',
      });
      expect(newMemory.id).toBeDefined();

      // Verify search still works (uses LanceDB)
      const results = await store.search('Persistent', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle multiple close/reopen cycles', async () => {
      for (let i = 0; i < 3; i++) {
        await store.create({ content: `Cycle ${i}`, category: 'fact' });
        store.close();
        await store.init();
      }

      // Should have all 3 memories
      const all = store.list();
      expect(all.total).toBe(3);
      expect(all.items.length).toBe(3);
    });
  });
});
