/**
 * Reads the agent's own memory and recent session context directly from the
 * OpenClaw state directory, so the daily profile refresh can inject them into
 * the prompt as *concrete material* rather than telling the agent to "go look".
 *
 * Why this exists: the refresh is delivered to a silent subagent (deliver:false)
 * which does NOT get memory-core's automatic pre-turn memory injection, and in
 * practice the agent dismisses "use your memory" instructions. Pulling the
 * content in here guarantees it reaches the model.
 *
 * Both sources are best-effort: any failure (missing file, locked DB, parse
 * error) yields an empty list and is logged at debug, never thrown.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from './logger';

export interface RefreshContext {
  /** Snippets pulled from the agent's durable memory (memory-core sqlite). */
  memorySnippets: string[];
  /** Recent user-driven topics pulled from the latest session transcript. */
  sessionSnippets: string[];
}

export const EMPTY_CONTEXT: RefreshContext = { memorySnippets: [], sessionSnippets: [] };

const MAX_MEMORY_CHARS = 4000;
const MAX_SESSION_TURNS = 12;
const MAX_SESSION_SNIPPET_CHARS = 280;

/**
 * Collect memory + recent-session context for an agent from the OpenClaw state
 * directory (`api.rootDir`, e.g. ~/.openclaw).
 */
export function collectOpenClawContext(
  stateDir: string,
  logger: Logger,
  options?: { agentName?: string }
): RefreshContext {
  const agentName = options?.agentName ?? 'main';
  return {
    memorySnippets: readMemorySnippets(stateDir, agentName, logger),
    sessionSnippets: readSessionSnippets(stateDir, agentName, logger),
  };
}

/**
 * Read durable memory chunks from `<stateDir>/memory/<agent>.sqlite` (memory-core
 * store). Returns the chunk texts, total capped at MAX_MEMORY_CHARS.
 */
function readMemorySnippets(stateDir: string, agentName: string, logger: Logger): string[] {
  const dbPath = join(stateDir, 'memory', `${agentName}.sqlite`);
  let db: DatabaseSync | undefined;
  try {
    // Read-only so we never interfere with memory-core's writer (WAL mode).
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT text FROM chunks ORDER BY rowid DESC LIMIT 50')
      .all() as Array<{ text?: unknown }>;

    const snippets: string[] = [];
    let total = 0;
    for (const row of rows) {
      const text = typeof row.text === 'string' ? row.text.trim() : '';
      if (!text) continue;
      if (total + text.length > MAX_MEMORY_CHARS) break;
      snippets.push(text);
      total += text.length;
    }
    return snippets;
  } catch (err) {
    logger.debug(`readMemorySnippets: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

/**
 * Read the most recent session transcript for the agent and extract recent
 * user-driven topics — what the user is actually working on. Skips EigenFlux
 * system payloads (feed/refresh/PM) so broadcasts don't leak back in as
 * "session" signal.
 */
function readSessionSnippets(stateDir: string, agentName: string, logger: Logger): string[] {
  try {
    const dir = join(stateDir, 'agents', agentName, 'sessions');
    const latest = latestSessionFile(dir);
    if (!latest) return [];

    const lines = readFileSync(latest, 'utf-8').split('\n');
    const snippets: string[] = [];
    // Walk newest-first, collecting user/assistant text turns.
    for (let i = lines.length - 1; i >= 0 && snippets.length < MAX_SESSION_TURNS; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      const text = extractTurnText(line);
      if (text) snippets.push(text);
    }
    return snippets.reverse();
  } catch (err) {
    logger.debug(`readSessionSnippets: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function latestSessionFile(dir: string): string | undefined {
  let newest: { path: string; mtime: number } | undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl') || name.endsWith('.trajectory.jsonl')) continue;
    const path = join(dir, name);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    } catch {
      // skip unreadable entries
    }
  }
  return newest?.path;
}

/**
 * Pull human-meaningful text out of one transcript JSONL line. Returns undefined
 * for tool calls, sentinels, and EigenFlux system payloads.
 */
function extractTurnText(line: string): string | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const message = (obj as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return undefined;

  const role = (message as { role?: unknown }).role;
  if (role !== 'user' && role !== 'assistant') return undefined;

  const content = (message as { content?: unknown }).content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((c): c is { type: string; text: string } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string')
      .map((c) => c.text)
      .join(' ');
  }
  text = text.trim();
  if (!text) return undefined;

  // Drop EigenFlux system payloads and bare sentinels — they are noise here.
  if (/EIGENFLUX_FEED_PAYLOAD|profile is due for|EigenFlux feed payload/i.test(text)) return undefined;
  if (/^(NO_REPLY|HEARTBEAT_OK|Triggered a silent profile refresh)/.test(text)) return undefined;

  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > MAX_SESSION_SNIPPET_CHARS
    ? `${oneLine.slice(0, MAX_SESSION_SNIPPET_CHARS)}…`
    : oneLine;
}
