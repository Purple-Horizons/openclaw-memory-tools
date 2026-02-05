/**
 * Configuration Schema for Memory-as-Tools Plugin
 */

import { Type, type Static } from '@sinclair/typebox';
import { MEMORY_CATEGORIES, VECTOR_DIMS } from './types.js';

export const embeddingConfigSchema = Type.Object({
  apiKey: Type.String(),
  model: Type.Optional(Type.Union([
    Type.Literal('text-embedding-3-small'),
    Type.Literal('text-embedding-3-large'),
  ])),
});

export const memoryToolsConfigSchema = Type.Object({
  embedding: embeddingConfigSchema,
  dbPath: Type.Optional(Type.String()),
  autoInjectInstructions: Type.Optional(Type.Boolean()),
  decayCheckInterval: Type.Optional(Type.Number()),
});

export type MemoryToolsConfig = Static<typeof memoryToolsConfigSchema>;

export function parseConfig(raw: unknown): MemoryToolsConfig {
  // Simple validation - in production you'd use a proper validator
  const config = raw as Record<string, unknown>;

  if (!config.embedding || typeof config.embedding !== 'object') {
    throw new Error('Missing embedding configuration');
  }

  const embedding = config.embedding as Record<string, unknown>;
  if (!embedding.apiKey || typeof embedding.apiKey !== 'string') {
    throw new Error('Missing embedding.apiKey');
  }

  return {
    embedding: {
      apiKey: embedding.apiKey,
      model: (embedding.model as string) || 'text-embedding-3-small',
    },
    dbPath: (config.dbPath as string) || '~/.openclaw/memory/tools',
    autoInjectInstructions: config.autoInjectInstructions !== false,
    decayCheckInterval: (config.decayCheckInterval as number) ?? 24,
  };
}

export { MEMORY_CATEGORIES, VECTOR_DIMS };
