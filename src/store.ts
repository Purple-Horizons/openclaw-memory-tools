/**
 * Hybrid Memory Store
 *
 * SQLite (via sql.js/WASM) for metadata (fast queries, debuggable, no native deps)
 * LanceDB for vectors (semantic search)
 */

import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js';
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
  private db: SqlJsDatabase | null = null;
  private vectorDb: lancedb.Connection | null = null;
  private vectorTable: lancedb.Table | null = null;
  private embeddings: EmbeddingProvider;
  private vectorDim: number;
  private dbPath: string;
  private dbFilePath: string;
  private initPromise: Promise<void> | null = null;
  private sqliteInitPromise: Promise<void> | null = null;

  constructor(
    dbPath: string,
    embeddings: EmbeddingProvider,
    vectorDim: number
  ) {
    this.dbPath = dbPath;
    this.embeddings = embeddings;
    this.vectorDim = vectorDim;
    this.dbFilePath = path.join(dbPath, 'memory.db');

    // Ensure directory exists
    if (!fs.existsSync(dbPath)) {
      fs.mkdirSync(dbPath, { recursive: true });
    }
  }

  /**
   * Initialize the database. Call this before using sync methods.
   * Async methods will auto-initialize, but this is useful for tests
   * or when you need to use sync methods without calling async ones first.
   */
  async init(): Promise<void> {
    await this.ensureSqlite();
  }

  /**
   * Ensure SQLite is initialized (lazy async init for sql.js WASM)
   */
  private async ensureSqlite(): Promise<SqlJsDatabase> {
    if (this.db) return this.db;
    if (this.sqliteInitPromise) {
      await this.sqliteInitPromise;
      return this.db!;
    }

    this.sqliteInitPromise = this.initSqlite();
    await this.sqliteInitPromise;
    return this.db!;
  }

  private async initSqlite(): Promise<void> {
    const SQL = await initSqlJs();

    // Load existing database if it exists
    if (fs.existsSync(this.dbFilePath)) {
      const buffer = fs.readFileSync(this.dbFilePath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    // Create schema
    this.db.run(`
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
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at)`);

    this.save();
  }

  /**
   * Persist database to disk
   */
  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    fs.writeFileSync(this.dbFilePath, Buffer.from(data));
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
    const db = await this.ensureSqlite();
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
    db.run(`
      INSERT INTO memories (
        id, content, category, confidence, importance,
        created_at, updated_at, last_accessed_at, decay_days,
        source_channel, source_message_id, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ]);

    this.save();
    return (await this.getAsync(id))!;
  }

  /**
   * Async version of get for internal use
   */
  private async getAsync(id: string): Promise<Memory | null> {
    const db = await this.ensureSqlite();
    return this.getFromDb(db, id);
  }

  /**
   * Sync get - requires ensureSqlite() to have been called first
   */
  get(id: string): Memory | null {
    if (!this.db) {
      throw new Error('Database not initialized. Call an async method first or use getAsync().');
    }
    return this.getFromDb(this.db, id);
  }

  private getFromDb(db: SqlJsDatabase, id: string): Memory | null {
    let query = 'SELECT * FROM memories WHERE id = ?';
    let param: string = id;

    if (id.length === 8) {
      query = 'SELECT * FROM memories WHERE id LIKE ? LIMIT 1';
      param = `${id}%`;
    }

    const stmt = db.prepare(query);
    stmt.bind([param]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return this.rowToMemory(row);
  }

  async update(id: string, updates: UpdateMemoryInput): Promise<Memory> {
    const db = await this.ensureSqlite();
    await this.ensureVectorDb();

    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [Date.now()];

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

    db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params as SqlValue[]);
    this.save();

    return (await this.getAsync(id))!;
  }

  async delete(id: string, reason?: string): Promise<void> {
    const db = await this.ensureSqlite();
    await this.ensureVectorDb();

    // Support both full UUID and short ID (first 8 chars)
    let fullId = id;
    if (id.length === 8) {
      const stmt = db.prepare('SELECT id FROM memories WHERE id LIKE ? AND deleted_at IS NULL LIMIT 1');
      stmt.bind([`${id}%`]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as { id: string };
        fullId = row.id;
      }
      stmt.free();
    }

    // Soft delete in SQLite
    db.run(`
      UPDATE memories
      SET deleted_at = ?, delete_reason = ?
      WHERE id = ?
    `, [Date.now(), reason ?? null, fullId]);

    this.save();

    // Remove from vector index
    await this.vectorTable!.delete(`id = '${fullId}'`);
  }

  async search(opts: SearchOptions): Promise<MemorySearchResult[]> {
    const db = await this.ensureSqlite();
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
    const params: SqlValue[] = [];

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

    const rows = this.queryAll(db, sql, params);

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

  /**
   * Async version of list
   */
  async listAsync(opts: ListOptions = {}): Promise<{ total: number; items: Memory[] }> {
    const db = await this.ensureSqlite();
    return this.listFromDb(db, opts);
  }

  /**
   * Sync list - requires database to be initialized
   */
  list(opts: ListOptions = {}): { total: number; items: Memory[] } {
    if (!this.db) {
      throw new Error('Database not initialized. Call an async method first or use listAsync().');
    }
    return this.listFromDb(this.db, opts);
  }

  private listFromDb(db: SqlJsDatabase, opts: ListOptions): { total: number; items: Memory[] } {
    const sortBy = opts.sortBy ?? 'created_at';
    const sortCol = sortBy.replace(/([A-Z])/g, '_$1').toLowerCase();
    const sortOrder = opts.sortOrder ?? 'desc';

    let sql = 'SELECT * FROM memories WHERE deleted_at IS NULL';
    const params: SqlValue[] = [];

    if (opts.category) {
      sql += ' AND category = ?';
      params.push(opts.category);
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as count');
    const countResult = this.queryOne(db, countSql, params as SqlValue[]) as { count: number };

    sql += ` ORDER BY ${sortCol} ${sortOrder}`;
    sql += ' LIMIT ? OFFSET ?';
    params.push(opts.limit ?? 20, opts.offset ?? 0);

    const rows = this.queryAll(db, sql, params);

    return {
      total: countResult.count,
      items: rows.map(row => this.rowToMemory(row)),
    };
  }

  async findDuplicates(content: string, threshold: number = 0.95): Promise<MemorySearchResult[]> {
    await this.ensureSqlite();
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

    const memory = await this.getAsync(results[0].id as string);
    if (!memory || memory.deletedAt) return [];

    return [{ memory, score }];
  }

  /**
   * Async version of touchMany
   */
  async touchManyAsync(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.ensureSqlite();
    this.touchManyInDb(db, ids);
  }

  /**
   * Sync touchMany - requires database to be initialized
   */
  touchMany(ids: string[]): void {
    if (ids.length === 0) return;
    if (!this.db) {
      throw new Error('Database not initialized. Call an async method first or use touchManyAsync().');
    }
    this.touchManyInDb(this.db, ids);
  }

  private touchManyInDb(db: SqlJsDatabase, ids: string[]): void {
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    db.run(`UPDATE memories SET last_accessed_at = ? WHERE id IN (${placeholders})`, [now, ...ids]);
    this.save();
  }

  /**
   * Async version of count
   */
  async countAsync(): Promise<number> {
    const db = await this.ensureSqlite();
    return this.countFromDb(db);
  }

  /**
   * Sync count - requires database to be initialized
   */
  count(): number {
    if (!this.db) {
      throw new Error('Database not initialized. Call an async method first or use countAsync().');
    }
    return this.countFromDb(this.db);
  }

  private countFromDb(db: SqlJsDatabase): number {
    const result = this.queryOne(db, 'SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL', []) as { count: number };
    return result.count;
  }

  /**
   * Async version of getByCategory
   */
  async getByCategoryAsync(category: MemoryCategory, limit: number = 50): Promise<Memory[]> {
    const db = await this.ensureSqlite();
    return this.getByCategoryFromDb(db, category, limit);
  }

  /**
   * Sync getByCategory - requires database to be initialized
   */
  getByCategory(category: MemoryCategory, limit: number = 50): Memory[] {
    if (!this.db) {
      throw new Error('Database not initialized. Call an async method first or use getByCategoryAsync().');
    }
    return this.getByCategoryFromDb(this.db, category, limit);
  }

  private getByCategoryFromDb(db: SqlJsDatabase, category: MemoryCategory, limit: number): Memory[] {
    const rows = this.queryAll(db, `
      SELECT * FROM memories
      WHERE category = ? AND deleted_at IS NULL
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `, [category, limit]);

    return rows.map(row => this.rowToMemory(row));
  }

  /**
   * Helper to run a query and get all results as objects
   */
  private queryAll(db: SqlJsDatabase, sql: string, params: SqlValue[]): Record<string, unknown>[] {
    const stmt = db.prepare(sql);
    stmt.bind(params);

    const results: Record<string, unknown>[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return results;
  }

  /**
   * Helper to run a query and get first result as object
   */
  private queryOne(db: SqlJsDatabase, sql: string, params: SqlValue[]): Record<string, unknown> | null {
    const stmt = db.prepare(sql);
    stmt.bind(params);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return row;
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
    // Close SQLite connection
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }

    // Close LanceDB connection
    if (this.vectorDb) {
      this.vectorDb.close();
      this.vectorDb = null;
    }
    this.vectorTable = null;

    // Reset initialization promises so databases can be reopened
    this.initPromise = null;
    this.sqliteInitPromise = null;
  }
}
