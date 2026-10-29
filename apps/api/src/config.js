import 'dotenv/config';
import path from 'node:path';
export const config = {
  port: Number(process.env.PORT || 3001), host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  databaseUrl: process.env.DATABASE_URL || '', redisUrl: process.env.REDIS_URL || '',
  ocrUrl: process.env.OCR_URL || 'http://127.0.0.1:8000',
  internalToken: process.env.INTERNAL_TOKEN || '', apiToken: process.env.API_TOKEN || '',
  extractionMode: process.env.EXTRACTION_MODE || 'offline',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY || '',
  baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  semantic: process.env.SEMANTIC_SEARCH === 'true', embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  maxUpload: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
};
if (!['offline', 'openai'].includes(config.extractionMode)) throw new Error('EXTRACTION_MODE must be offline or openai');
if (config.extractionMode === 'openai' && !config.apiKey) throw new Error('OPENAI_API_KEY required for openai mode');
if (process.env.NODE_ENV === 'production' && (!config.apiToken || !config.internalToken)) throw new Error('Production requires API_TOKEN and INTERNAL_TOKEN');
