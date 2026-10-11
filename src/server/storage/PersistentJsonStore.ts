import { Pool } from 'pg';

export interface StoredSnapshotFile {
  relativePath: string;
  content: Buffer;
}

export class PersistentJsonStore {
  private readonly pool?: Pool;
  private readonly inMemoryDocs = new Map<string, any>();
  private readonly inMemorySnapshots = new Map<string, StoredSnapshotFile[]>();
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) {
      console.warn('[AI Studio] DATABASE_URL not set — using in-memory mock store');
      return;
    }

    try {
      this.pool = new Pool({
        connectionString,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        max: 10,
      });
    } catch (err) {
      console.warn('[AI Studio] DB not connected — mock active', err);
    }
  }

  async checkConnection(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.query('SELECT 1');
        return;
      } catch (err) {
        console.warn('[AI Studio] DB connection failed, falling back to mock:', err);
      }
    }
  }

  async getOrSeed<T>(key: string, initialValue: T): Promise<T> {
    if (this.pool) {
      try {
        const existing = await this.pool.query<{ payload: T }>(
          'SELECT payload FROM rare_persistent_documents WHERE document_key = $1',
          [key],
        );
        if (existing.rows.length > 0) return existing.rows[0].payload;

        const inserted = await this.pool.query<{ payload: T }>(
          `INSERT INTO rare_persistent_documents (document_key, payload)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (document_key) DO NOTHING
           RETURNING payload`,
          [key, JSON.stringify(initialValue)],
        );
        if (inserted.rows.length > 0) return inserted.rows[0].payload;

        const raced = await this.pool.query<{ payload: T }>(
          'SELECT payload FROM rare_persistent_documents WHERE document_key = $1',
          [key],
        );
        if (raced.rows.length > 0) return raced.rows[0].payload;
      } catch (err) {
        console.warn('[AI Studio] DB query failed, falling back to in-memory store:', err);
      }
    }
    if (!this.inMemoryDocs.has(key)) {
      this.inMemoryDocs.set(key, initialValue);
    }
    return this.inMemoryDocs.get(key) as T;
  }

  setDocument(key: string, value: unknown): void {
    this.inMemoryDocs.set(key, value);
    if (!this.pool) return;
    const payload = JSON.stringify(value);
    this.enqueue(key, async () => {
      if (!this.pool) return;
      try {
        await this.pool.query(
          `INSERT INTO rare_persistent_documents (document_key, payload, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (document_key)
           DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
          [key, payload],
        );
      } catch (err) {
        console.warn('[AI Studio] DB setDocument write failed:', err);
      }
    });
  }

  async loadSnapshotFiles(checkpointId: string): Promise<StoredSnapshotFile[]> {
    if (this.pool) {
      try {
        const result = await this.pool.query<{ relative_path: string; content: Buffer }>(
          `SELECT relative_path, content
           FROM rare_checkpoint_files
           WHERE checkpoint_id = $1
           ORDER BY relative_path`,
          [checkpointId],
        );
        return result.rows.map((row) => ({
          relativePath: row.relative_path,
          content: row.content,
        }));
      } catch (err) {
        console.warn('[AI Studio] DB loadSnapshotFiles failed, fallback to in-memory:', err);
      }
    }
    return this.inMemorySnapshots.get(checkpointId) || [];
  }

  setSnapshotFiles(checkpointId: string, files: StoredSnapshotFile[]): void {
    const snapshot = files.map((file) => ({
      relativePath: file.relativePath,
      content: Buffer.from(file.content),
    }));
    this.inMemorySnapshots.set(checkpointId, snapshot);

    if (!this.pool) return;

    this.enqueue(`checkpoint-files:${checkpointId}`, async () => {
      if (!this.pool) return;
      let client;
      try {
        client = await this.pool.connect();
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM rare_checkpoint_files WHERE checkpoint_id = $1',
          [checkpointId],
        );
        for (const file of snapshot) {
          await client.query(
            `INSERT INTO rare_checkpoint_files (checkpoint_id, relative_path, content)
             VALUES ($1, $2, $3)`,
            [checkpointId, file.relativePath, file.content],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.warn('[AI Studio] DB setSnapshotFiles write failed:', error);
      } finally {
        if (client) client.release();
      }
    });
  }

  async flush(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      const writes = [...this.pendingWrites.entries()];
      const results = await Promise.allSettled(writes.map(([, write]) => write));

      for (const [key, write] of writes) {
        if (this.pendingWrites.get(key) === write) this.pendingWrites.delete(key);
      }

      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    }
  }

  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      if (this.pool) {
        await this.pool.end().catch(() => {});
      }
    }
  }

  private enqueue(key: string, write: () => Promise<void>): void {
    const previous = this.pendingWrites.get(key);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(write);
    this.pendingWrites.set(key, next);
  }
}
