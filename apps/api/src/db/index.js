import {DatabaseSync} from 'node:sqlite';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {schema, postgresSearch} from './schema.js';
import {config} from '../config.js';

export const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
export class Database {
  constructor(options = {}) {
    this.url = options.url ?? config.databaseUrl;
    this.file = options.file ?? path.join(config.dataDir, 'documents.sqlite');
    this.postgres = Boolean(this.url);
    this.context = new AsyncLocalStorage(); this.tail = Promise.resolve();
  }
  async open() {
    if (this.postgres) this.pool = new pg.Pool({connectionString:this.url, max:10, connectionTimeoutMillis:5000});
    else {
      await mkdir(path.dirname(this.file), {recursive:true});
      this.sqlite = new DatabaseSync(this.file);
      this.sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    }
    await this.transaction(async db => {
      if (this.postgres) await db.query("SELECT pg_advisory_xact_lock(691212)");
      await db.exec(schema(this.postgres));
      if (this.postgres) await db.exec(postgresSearch);
      if(this.postgres)await db.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS task TEXT NOT NULL DEFAULT 'process'");
      else if(!(await db.query('PRAGMA table_info(jobs)')).rows.some(c=>c.name==='task'))await db.exec("ALTER TABLE jobs ADD COLUMN task TEXT NOT NULL DEFAULT 'process'");
      if(this.postgres)await db.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_model TEXT');
      else if(!(await db.query('PRAGMA table_info(documents)')).rows.some(c=>c.name==='extraction_model'))await db.exec('ALTER TABLE documents ADD COLUMN extraction_model TEXT');
      await db.query('INSERT INTO schema_migrations(version,applied_at) VALUES (1,$1) ON CONFLICT(version) DO NOTHING', [new Date().toISOString()]);
      await db.query('INSERT INTO schema_migrations(version,applied_at) VALUES (2,$1) ON CONFLICT(version) DO NOTHING', [new Date().toISOString()]);
      await db.query('INSERT INTO schema_migrations(version,applied_at) VALUES (3,$1) ON CONFLICT(version) DO NOTHING', [new Date().toISOString()]);
    });
    return this;
  }
  async exclusive(fn) {
    if (this.context.getStore()) return fn();
    const prior = this.tail; let release;
    this.tail = new Promise(resolve => {release = resolve;});
    await prior;
    try {return await this.context.run(true, fn);} finally {release();}
  }
  async query(sql, values = []) {
    if (this.postgres) return this.pool.query(sql, values);
    return this.exclusive(() => {
      const args = [];
      const prepared = sql.replace(/\$(\d+)/g, (_, n) => {const v=values[Number(n)-1]; args.push(typeof v === 'boolean' ? Number(v) : v ?? null); return '?';});
      const stmt = this.sqlite.prepare(prepared);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(prepared) || /\bRETURNING\b/i.test(prepared)) {
        const rows = stmt.all(...args); return {rows, rowCount:rows.length};
      }
      const result = stmt.run(...args); return {rows:[], rowCount:Number(result.changes)};
    });
  }
  async exec(sql) {if (this.postgres) return this.pool.query(sql); return this.exclusive(() => this.sqlite.exec(sql));}
  async transaction(fn) {
    if (this.postgres) {
      const client=await this.pool.connect();
      const db={postgres:true, query:(...args)=>client.query(...args), exec:sql=>client.query(sql)};
      try {await client.query('BEGIN'); const out=await fn(db); await client.query('COMMIT'); return out;}
      catch(e) {await client.query('ROLLBACK'); throw e;} finally {client.release();}
    }
    return this.exclusive(async () => {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {const out=await fn(this); this.sqlite.exec('COMMIT'); return out;}
      catch(e) {this.sqlite.exec('ROLLBACK'); throw e;}
    });
  }
  async close() {if (this.pool) await this.pool.end(); else this.sqlite?.close();}
}
