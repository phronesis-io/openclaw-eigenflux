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

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Logger } from './logger';

/**
 * Memory markdown lives under the OpenClaw workspace, relative to the state dir
 * (api.rootDir): `<stateDir>/workspace/memory/*.md`. These markdown files are
 * memory-core's source of truth — read them directly so memory works even when
 * the sqlite vector index is unavailable (e.g. no embedding key configured).
 */
const MEMORY_DIR_REL = ['workspace', 'memory'];

export interface RefreshContext {
  /** Snippets pulled from the agent's durable memory (memory markdown). */
  memorySnippets: string[];
  /** Recent user-driven topics pulled from the latest session transcript. */
  sessionSnippets: string[];
}

export const EMPTY_CONTEXT: RefreshContext = { memorySnippets: [], sessionSnippets: [] };

/**
 * Resolve the OpenClaw state directory (e.g. ~/.openclaw), where memory/ and
 * agents/ live. NOTE: this is NOT `api.rootDir` — that is the plugin's own
 * install directory. The canonical source is the SDK's resolveStateDir(); we
 * fall back to the gateway's cwd and then ~/.openclaw so a missing/renamed SDK
 * export degrades gracefully instead of reading from the wrong place.
 */
export function resolveOpenClawStateDir(logger: Logger): string | undefined {
  try {
    // Deep SDK subpath — load defensively so an SDK change can't break plugin load.
    const mod = require('openclaw/plugin-sdk/memory-core-host-runtime-core') as {
      resolveStateDir?: () => string;
    };
    const dir = mod.resolveStateDir?.();
    if (dir && typeof dir === 'string') return dir;
  } catch (err) {
    logger.debug(`resolveOpenClawStateDir: SDK resolveStateDir unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Fallbacks: the gateway runs with cwd = state dir; then the default location.
  const cwd = process.cwd();
  if (cwd && existsSync(join(cwd, 'agents'))) return cwd;
  const home = join(homedir(), '.openclaw');
  if (existsSync(join(home, 'agents'))) return home;
  return undefined;
}

const MAX_MEMORY_CHARS = 4000;
const MAX_MEMORY_FILES = 20;
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
    memorySnippets: readMemorySnippets(stateDir, logger),
    sessionSnippets: readSessionSnippets(stateDir, agentName, logger),
  };
}

/**
 * Read durable memory from the markdown files under `<stateDir>/workspace/memory`
 * (memory-core's source of truth). Newest files first, total capped at
 * MAX_MEMORY_CHARS. Reading markdown directly avoids the sqlite vector index,
 * so memory works even without an embedding key.
 */
function readMemorySnippets(stateDir: string, logger: Logger): string[] {
  const dir = join(stateDir, ...MEMORY_DIR_REL);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    logger.debug(`readMemorySnippets: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const files = entries
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((f): f is { path: string; mtime: number } => !!f)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_MEMORY_FILES);

  const snippets: string[] = [];
  let total = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.path, 'utf-8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    if (total + text.length > MAX_MEMORY_CHARS) {
      text = text.slice(0, Math.max(0, MAX_MEMORY_CHARS - total)).trim();
    }
    if (!text) break;
    snippets.push(text);
    total += text.length;
    if (total >= MAX_MEMORY_CHARS) break;
  }
  return snippets;
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
