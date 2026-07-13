import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Per-session "last processed message createdAt" store. Implementations must be durable
 *  for at-least-once delivery across restarts. set() only advances forward. */
export interface CursorStore {
  get(sessionId: string): string | null;
  set(sessionId: string, createdAt: string): void;
}

export class InMemoryCursorStore implements CursorStore {
  private map = new Map<string, string>();
  get(sessionId: string): string | null {
    return this.map.get(sessionId) ?? null;
  }
  set(sessionId: string, createdAt: string): void {
    const prev = this.map.get(sessionId);
    if (prev === undefined || createdAt > prev) this.map.set(sessionId, createdAt);
  }
}

export class FileCursorStore implements CursorStore {
  private cache: Map<string, string> | null = null;
  constructor(private readonly path: string) {}

  private load(): Map<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = new Map();
      return this.cache;
    }
    const raw = readFileSync(this.path, 'utf8');
    try {
      this.cache = new Map(Object.entries(JSON.parse(raw)));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  private persist(): void {
    if (!this.cache) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.cache), null, 2), 'utf8');
  }

  get(sessionId: string): string | null {
    return this.load().get(sessionId) ?? null;
  }
  set(sessionId: string, createdAt: string): void {
    const m = this.load();
    const prev = m.get(sessionId);
    if (prev === undefined || createdAt > prev) {
      m.set(sessionId, createdAt);
      this.persist();
    }
  }
}
