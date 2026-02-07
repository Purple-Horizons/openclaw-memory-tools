/**
 * Hybrid Memory Store
 *
 * SQLite for metadata (fast queries, debuggable)
 * LanceDB for vectors (semantic search)
 */

import Database from 'better-sqlite3';
import * as lancedb from '@lancedb/lancedb';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Memory,
  MemorySearchResult,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchOptions,
  ListOptions,
  MemoryCategory,
} from './types.js';
import { EmbeddingProvider } from './embeddings.js';

const VECTOR_TABLE = 'memory_vectors';

export class MemoryStore {
  private db: Database.Database;
  private vectorDb: lancedb.Connection | null = null;
  private vectorTable: lancedb.Table | null = null;
  private embeddings: EmbeddingProvider;
  private vectorDim: number;
  private dbPath: string;
  private initPromise: Promise<void> | null = null;

  constructor(
    dbPath: string,
    embeddings: EmbeddingProvider,
    vectorDim: number
  ) {
    this.dbPath = dbPath;
    this.embeddings = embeddings;
    this.vectorDim = vectorDim;

    // Ensure directory exists
    if (!fs.existsSync(dbPath)) {
      fs.mkdirSync(dbPath, { recursive: true });
    }

    // Initialize SQLite
    this.db = new Database(path.join(dbPath, 'memory.db'));
    this.db.pragma('journal_mode = WAL');
    this.initSqlite();
  }

  private initSqlite(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        confidence REAL DEFAULT 0.8,
        importance REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        decay_days INTEGER,
        source_channel TEXT,
        source_message_id TEXT,
        tags TEXT,
        supersedes TEXT,
        deleted_at INTEGER,
        delete_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at);
    `);
  }

  private async ensureVectorDb(): Promise<void> {
    if (this.vectorTable) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initVectorDb();
    return this.initPromise;
  }

  private async initVectorDb(): Promise<void> {
    const vectorPath = path.join(this.dbPath, 'vectors');
    this.vectorDb = await lancedb.connect(vectorPath);

    const tables = await this.vectorDb.tableNames();

    if (tables.includes(VECTOR_TABLE)) {
      this.vectorTable = await this.vectorDb.openTable(VECTOR_TABLE);
    } else {
      // Create with schema row then delete it
      this.vectorTable = await this.vectorDb.createTable(VECTOR_TABLE, [{
        id: '__schema__',
        vector: new Array(this.vectorDim).fill(0),
        text: '',
      }]);
      await this.vectorTable.delete('id = "__schema__"');
    }
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    await this.ensureVectorDb();

    const id = randomUUID();
    const now = Date.now();

    // Generate embedding
    const vector = await this.embeddings.embed(input.content);

    // Store vector in LanceDB
    await this.vectorTable!.add([{
      id,
      vector,
      text: input.content,
    }]);

    // Store metadata in SQLite
    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, content, category, confidence, importance,
        created_at, updated_at, last_accessed_at, decay_days,
        source_channel, source_message_id, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.content,
      input.category,
      input.confidence ?? 0.8,
      input.importance ?? 0.5,
      now,
      now,
      now,
      input.decayDays ?? null,
      input.sourceChannel ?? null,
      input.sourceMessageId ?? null,
      JSON.stringify(input.tags ?? [])
    );

    return this.get(id)!;
  }

  get(id: string): Memory | null {
    // Support both full UUID and short ID (first 8 chars)
    let query = 'SELECT * FROM memories WHERE id = ?';
    let param: string = id;

    if (id.length === 8) {
      query = 'SELECT * FROM memories WHERE id LIKE ? LIMIT 1';
      param = `${id}%`;
    }

    const row = this.db.prepare(query).get(param) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  async update(id: string, updates: UpdateMemoryInput): Promise<Memory> {
    await this.ensureVectorDb();

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];

    if (updates.content !== undefined) {
      sets.push('content = ?');
      params.push(updates.content);

      // Re-embed and update vector
      const vector = await this.embeddings.embed(updates.content);
      await this.vectorTable!.update({
        where: `id = '${id}'`,
        values: { vector, text: updates.content },
      });
    }

    if (updates.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(updates.confidence);
    }

    if (updates.importance !== undefined) {
      sets.push('importance = ?');
      params.push(updates.importance);
    }

    if (updates.decayDays !== undefined) {
      sets.push('decay_days = ?');
      params.push(updates.decayDays);
    }

    if (updates.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }

    params.push(id);

    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return this.get(id)!;
  }

  async delete(id: string, reason?: string): Promise<void> {
    await this.ensureVectorDb();

    // Support both full UUID and short ID (first 8 chars)
    let fullId = id;
    if (id.length === 8) {
      const row = this.db.prepare(
        'SELECT id FROM memories WHERE id LIKE ? AND deleted_at IS NULL LIMIT 1'
      ).get(`${id}%`) as { id: string } | undefined;
      if (row) {
        fullId = row.id;
      }
    }

    // Soft delete in SQLite
    this.db.prepare(`
      UPDATE memories
      SET deleted_at = ?, delete_reason = ?
      WHERE id = ?
    `).run(Date.now(), reason ?? null, fullId);

    // Remove from vector index
    await this.vectorTable!.delete(`id = '${fullId}'`);
  }

  async search(opts: SearchOptions): Promise<MemorySearchResult[]> {
    await this.ensureVectorDb();

    let vectorIds: string[] = [];
    const vectorScores = new Map<string, number>();

    // Semantic search if query provided
    if (opts.query) {
      const queryVector = await this.embeddings.embed(opts.query);
      const results = await this.vectorTable!
        .vectorSearch(queryVector)
        .limit((opts.limit ?? 10) * 2)  // Over-fetch for filtering
        .toArray();

      for (const row of results) {
        const distance = (row._distance as number) ?? 0;
        const score = 1 / (1 + distance);  // Convert L2 distance to similarity
        vectorIds.push(row.id as string);
        vectorScores.set(row.id as string, score);
      }
    }

    // Build SQL query
    let sql = 'SELECT * FROM memories WHERE deleted_at IS NULL';
    const params: unknown[] = [];

    if (vectorIds.length > 0) {
      sql += ` AND id IN (${vectorIds.map(() => '?').join(',')})`;
      params.push(...vectorIds);
    }

    if (opts.category) {
      sql += ' AND category = ?';
      params.push(opts.category);
    }

    if (opts.minConfidence !== undefined) {
      sql += ' AND confidence >= ?';
      params.push(opts.minConfidence);
    }

    if (opts.minImportance !== undefined) {
      sql += ' AND importance >= ?';
      params.push(opts.minImportance);
    }

    if (opts.tags?.length) {
      for (const tag of opts.tags) {
        sql += ' AND tags LIKE ?';
        params.push(`%"${tag}"%`);
      }
    }

    if (opts.excludeDecayed !== false) {
      sql += ` AND (decay_days IS NULL OR
        (created_at + decay_days * 86400000) > ?)`;
      params.push(Date.now());
    }

    sql += ' LIMIT ?';
    params.push(opts.limit ?? 10);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

    // Map results with scores
    const results: MemorySearchResult[] = rows.map(row => ({
      memory: this.rowToMemory(row),
      score: vectorScores.get(row.id as string) ?? 1.0,
    }));

    // Sort by vector score if semantic search was used
    if (vectorIds.length > 0) {
      const idOrder = new Map(vectorIds.map((id, i) => [id, i]));
      results.sort((a, b) =>
        (idOrder.get(a.memory.id) ?? 999) - (idOrder.get(b.memory.id) ?? 999)
      );
    }

    return results;
  }

  list(opts: ListOptions = {}): { total: number; items: Memory[] } {
    const sortBy = opts.sortBy ?? 'created_at';
    const sortCol = sortBy.replace(/([A-Z])/g, '_$1').toLowerCase();
    const sortOrder = opts.sortOrder ?? 'desc';

    let sql = 'SELECT * FROM memories WHERE deleted_at IS NULL';
    const params: unknown[] = [];

    if (opts.category) {
      sql += ' AND category = ?';
      params.push(opts.category);
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
    const countResult = this.db.prepare(countSql).get(...params) as { count: number };

    sql += ` ORDER BY ${sortCol} ${sortOrder}`;
    sql += ' LIMIT ? OFFSET ?';
    params.push(opts.limit ?? 20, opts.offset ?? 0);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

    return {
      total: countResult.count,
      items: rows.map(row => this.rowToMemory(row)),
    };
  }

  async findDuplicates(content: string, threshold: number = 0.95): Promise<MemorySearchResult[]> {
    await this.ensureVectorDb();

    const vector = await this.embeddings.embed(content);
    const results = await this.vectorTable!
      .vectorSearch(vector)
      .limit(1)
      .toArray();

    if (results.length === 0) return [];

    const distance = (results[0]._distance as number) ?? 0;
    const score = 1 / (1 + distance);

    if (score < threshold) return [];

    const memory = this.get(results[0].id as string);
    if (!memory || memory.deletedAt) return [];

    return [{ memory, score }];
  }

  touchMany(ids: string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE memories SET last_accessed_at = ? WHERE id IN (${placeholders})
    `).run(now, ...ids);
  }

  count(): number {
    const result = this.db.prepare(
      'SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL'
    ).get() as { count: number };
    return result.count;
  }

  getByCategory(category: MemoryCategory, limit: number = 50): Memory[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE category = ? AND deleted_at IS NULL
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(category, limit) as Record<string, unknown>[];

    return rows.map(row => this.rowToMemory(row));
  }

  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      content: row.content as string,
      category: row.category as MemoryCategory,
      confidence: row.confidence as number,
      importance: row.importance as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastAccessedAt: row.last_accessed_at as number,
      decayDays: row.decay_days as number | null,
      sourceChannel: (row.source_channel as string | null) ?? undefined,
      sourceMessageId: (row.source_message_id as string | null) ?? undefined,
      tags: JSON.parse((row.tags as string) || '[]'),
      supersedes: (row.supersedes as string | null) ?? undefined,
      deletedAt: (row.deleted_at as number | null) ?? undefined,
      deleteReason: (row.delete_reason as string | null) ?? undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
