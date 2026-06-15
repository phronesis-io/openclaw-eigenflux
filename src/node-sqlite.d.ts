/**
 * Minimal ambient types for Node's built-in `node:sqlite` module (available at
 * runtime in the OpenClaw Node runtime, but not yet declared by @types/node).
 * Only the surface used by openclaw-context.ts is declared.
 */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  }
}
