/**
 * Host half of the session-purge bundle.
 *
 * Two authenticated exact-Fetch routes on the Host `/api` bridge
 * (`ctx.connection.fetch`):
 *
 *   GET  /api/session.purge.preview?sessionId=...  -> the markdown files a session wrote
 *   POST /api/session.purge                        -> archive the session, then move it and
 *                                                    those markdown files into a trash folder
 *
 * Route contract: the bridge calls the registered `fetch(request)` with a Fetch
 * `Request` and expects a Fetch `Response`. Registering these with
 * `webServer.register({ handler })` instead would pass Node `(req, res)` and the
 * request would hang forever, because a `handler` owns the response lifecycle.
 * The bridge also performs the browser/API authentication, Host/Origin trust
 * checks and request-size limits that the plugin no longer has to implement.
 *
 * Nothing is hard-deleted: the session directory and every markdown file move
 * under `$DSH_HOME/session-trash/<UTC stamp>/`, so the operation is recoverable
 * by hand. The session is hidden through the Workspace registry (the same durable
 * archive set the sidebar obeys) and detached from its project before the files
 * move; if the session has running work the registry refuses and nothing moves.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Exact browser-facing paths, both under the authenticated `/api` bridge. */
const PREVIEW_PATH = '/api/session.purge.preview';
const PURGE_PATH = '/api/session.purge';

/** Tools whose file argument names markdown the session may have produced. */
const MD_TOOLS = new Set(['write', 'edit', 'apply_patch']);

/** A preview may be reused by the confirming purge click for this long. */
const PREVIEW_TTL_MS = 60_000;

/** Session ids are opaque, cookie-safe tokens; reject anything else early. */
const SESSION_ID_PATTERN = /^[0-9a-zA-Z.-]+$/;

function jsonResponse(body, status = 200) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function statusForCode(code) {
  switch (code) {
    case 'bad-request':
      return 400;
    case 'not-found':
      return 404;
    case 'in-use':
      return 409;
    default:
      return 500;
  }
}

function errorResult(code, message, extra = {}) {
  return { ok: false, code, error: message, ...extra };
}

function defaultHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function isInside(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base + sep);
}

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * The path a markdown file gets inside the trash root's `md/` tree.
 *
 * The filesystem root is dropped — POSIX `/` or a Windows drive letter — so the
 * result is always relative. Keeping a drive letter would turn `join()` back into
 * an absolute Windows path outside the trash root.
 */
function trashRelativePath(filePath) {
  const full = resolve(filePath);
  return full.slice(parse(full).root.length).replace(/^[/\\]+/u, '');
}

/** Application data and dependency trees under the user's home that a purge must never touch. */
const HOME_EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.dsh',
  'Library',
  '.Trash',
  '.config',
  '.cache',
  '.local',
  '.npm',
  '.pnpm-store',
]);

/** Only paths the user plausibly owns are moved; the rest are left alone. */
function inUserSpace(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const full = resolve(filePath);
  const home = resolve(homedir());
  const inTemporary =
    full.startsWith('/tmp' + sep) ||
    full.startsWith('/private/tmp' + sep) ||
    full.startsWith('/var/folders' + sep);
  if (!inTemporary) {
    if (full === home || !full.startsWith(home + sep)) return false;
    const segments = full.slice(home.length + 1).split(sep);
    if (segments.some((segment) => HOME_EXCLUDED_SEGMENTS.has(segment))) return false;
  }
  return true;
}

/**
 * A markdown path named by one session event, or `undefined`.
 *
 * Accepts both the persisted event envelope and a bare `tool/call` payload so the
 * log scan and the session-query fallback share one parser. `arguments` is a JSON
 * string in a stored event; an already-parsed object is tolerated too.
 */
export function markdownPathFromEvent(event) {
  if (event === null || typeof event !== 'object') return undefined;
  if (event.type !== undefined && event.type !== 'tool/call') return undefined;
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;
  if (typeof data.name !== 'string' || !MD_TOOLS.has(data.name)) return undefined;
  let args = data.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (args === null || typeof args !== 'object') return undefined;
  const candidate = args.file_path ?? args.path;
  if (typeof candidate !== 'string' || !candidate.toLowerCase().endsWith('.md')) return undefined;
  if (!inUserSpace(candidate)) return undefined;
  return candidate;
}

/** Collect markdown paths from JSONL text, newest occurrence keeping its place. */
export function markdownPathsFromLogText(text) {
  const files = new Map();
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.includes('"tool/call"')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const candidate = markdownPathFromEvent(event);
    if (candidate !== undefined) files.set(candidate, (files.get(candidate) ?? 0) + 1);
  }
  return [...files.keys()];
}

/** Collect markdown paths from a session-query event array. */
export function markdownPathsFromEvents(events) {
  const files = new Map();
  if (!Array.isArray(events)) return [];
  for (const event of events) {
    const candidate = markdownPathFromEvent(event);
    if (candidate !== undefined) files.set(candidate, (files.get(candidate) ?? 0) + 1);
  }
  return [...files.keys()];
}

/**
 * Build the plugin's file and registry operations for one Harness home.
 *
 * `getService` resolves Host services lazily at request time so a profile without
 * the Workspace registry or session-query still loads the plugin (the routes then
 * degrade to moving files only).
 *
 * @param root0 - home and service lookup.
 * @param root0.home - `$DSH_HOME`; defaults to the process home.
 * @param root0.getService - lazy Host service accessor.
 * @returns preview and purge operations shared by both routes.
 */
export function createSessionPurge({ home = defaultHome(), getService = () => undefined } = {}) {
  const sessionsDir = join(home, 'sessions');
  const trashDir = join(home, 'session-trash');
  const previewCache = new Map();

  async function findSessionDir(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
    let entries;
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(sessionsDir, entry.name, sessionId);
      if (!isInside(sessionsDir, candidate)) continue;
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** The session's append-only log, whichever supported suffix it carries. */
  async function findLogFile(sessionDir) {
    let names;
    try {
      names = await readdir(sessionDir);
    } catch {
      return null;
    }
    const ranked = names
      .filter((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl.zst') || name.endsWith('.jsonl'))
      .sort((left, right) => Number(right.endsWith('.zstd')) - Number(left.endsWith('.zstd')));
    return ranked.length > 0 ? join(sessionDir, ranked[0]) : null;
  }

  async function readLogText(logFile) {
    if (!/\.zst(d)?$/u.test(logFile)) return readFile(logFile, 'utf8');
    const { stdout } = await execFileAsync('zstd', ['-dc', '--', logFile], {
      maxBuffer: 512 * 1024 * 1024,
      // A wedged decompressor must fail the request, not hold the route open.
      timeout: 20_000,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    return stdout;
  }

  /** Cheap identity of the log a scan saw, so a preview never outlives an appended log. */
  async function logSignature(logFile) {
    if (logFile === null) return 'none';
    try {
      const info = await stat(logFile);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return 'missing';
    }
  }

  /**
   * Markdown paths named by the session's tool calls.
   *
   * The compressed log scan is the fast path (roughly 0.2 s for a 35 MB log). When
   * the `zstd` binary is unavailable, or the log is unreadable, the Host
   * session-query corpus answers instead; a session with no log at all has none.
   */
  async function markdownPathsFor(sessionId, sessionDir) {
    const logFile = await findLogFile(sessionDir);
    const signature = await logSignature(logFile);
    const cached = previewCache.get(sessionId);
    if (cached !== undefined && cached.signature === signature && Date.now() - cached.at < PREVIEW_TTL_MS) {
      return cached.files;
    }

    let files = [];
    let source = 'none';
    if (logFile !== null) {
      try {
        files = markdownPathsFromLogText(await readLogText(logFile));
        source = 'log';
      } catch (error) {
        const sessionQuery = getService('sessionQuery');
        if (sessionQuery !== undefined && typeof sessionQuery.readSession === 'function') {
          const snapshot = await sessionQuery.readSession(sessionId);
          files = markdownPathsFromEvents(snapshot?.events);
          source = 'query';
        } else {
          throw error;
        }
      }
    } else {
      const sessionQuery = getService('sessionQuery');
      if (sessionQuery !== undefined && typeof sessionQuery.readSession === 'function') {
        const snapshot = await sessionQuery.readSession(sessionId);
        files = markdownPathsFromEvents(snapshot?.events);
        source = 'query';
      }
    }

    previewCache.set(sessionId, { files, source, signature, at: Date.now() });
    return files;
  }

  function invalidate(sessionId) {
    previewCache.delete(sessionId);
  }

  /** The existing markdown files a purge would move, with their total size. */
  async function existingMarkdown(sessionId, sessionDir) {
    const candidates = await markdownPathsFor(sessionId, sessionDir);
    const markdownFiles = [];
    const missing = [];
    let markdownBytes = 0;
    for (const file of candidates) {
      if (file === sessionDir || file.startsWith(sessionDir + sep)) continue;
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        markdownFiles.push(file);
        markdownBytes += info.size;
      } catch {
        missing.push(file);
      }
    }
    return { markdownFiles, missing, markdownBytes };
  }

  /** Whether the session is currently live (open in a Host agent loop). */
  function isLive(sessionId) {
    try {
      return getService('sessions')?.get(sessionId) !== undefined;
    } catch {
      return false;
    }
  }

  function archiveState(sessionId) {
    try {
      return Array.isArray(getService('workspaceRegistry')?.archivedSessionIds)
        ? getService('workspaceRegistry').archivedSessionIds.includes(sessionId)
        : false;
    } catch {
      return false;
    }
  }

  async function previewSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return errorResult('bad-request', 'invalid sessionId');
    }
    const sessionDir = await findSessionDir(sessionId);
    if (sessionDir === null) return errorResult('not-found', `session not found: ${sessionId}`);

    let markdownFiles = [];
    let missing = [];
    let markdownBytes = 0;
    try {
      ({ markdownFiles, missing, markdownBytes } = await existingMarkdown(sessionId, sessionDir));
    } catch (error) {
      return errorResult('internal', `cannot read the session log: ${String(error)}`, { sessionId });
    }

    return {
      ok: true,
      sessionId,
      sessionDir,
      markdownFiles,
      markdownBytes,
      missing,
      live: isLive(sessionId),
      archived: archiveState(sessionId),
    };
  }

  /**
   * Hide the session in the Workspace registry before its files move.
   *
   * `archiveSession` is the only durable way to make a sidebar row disappear, and
   * it is also the activity gate: running turns, subagents, tasks and active
   * reminders reject the archive, so a running session is never moved underneath
   * its own writer. `detachSession` then drops the now-gone id from its project.
   */
  async function hideSession(sessionId) {
    const registry = getService('workspaceRegistry');
    if (registry === undefined || typeof registry.archiveSession !== 'function') {
      return { archived: false, detached: false, warning: 'workspace registry unavailable; the sidebar row clears on restart' };
    }
    let archived = archiveState(sessionId);
    if (!archived) {
      try {
        await registry.archiveSession(sessionId);
        archived = true;
      } catch (error) {
        if (error?.name === 'WorkspaceActiveSessionError') {
          const activity = Array.isArray(error.activity)
            ? error.activity.map((entry) => entry?.kind).filter(Boolean).join(', ')
            : 'running work';
          return {
            blocked: true,
            error: `会话正在运行（${activity}），已取消删除。请等它结束后重试。`,
          };
        }
        if (error?.name !== 'WorkspaceUnknownSessionError') {
          return { failed: true, error: `cannot archive the session: ${String(error)}` };
        }
      }
    }

    let detached = false;
    try {
      const entities = typeof registry.list === 'function' ? registry.list() : [];
      const owner = entities.find(
        (entity) => Array.isArray(entity?.sessionIds) && entity.sessionIds.includes(sessionId),
      );
      if (owner !== undefined && typeof owner.detachSession === 'function') {
        await owner.detachSession(sessionId);
        detached = true;
      }
    } catch (error) {
      return { failed: true, archived, error: `session archived but cannot detach it from its project: ${String(error)}` };
    }

    return { archived, detached };
  }

  async function purgeSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return errorResult('bad-request', 'invalid sessionId');
    }
    const sessionDir = await findSessionDir(sessionId);
    if (sessionDir === null) return errorResult('not-found', `session not found: ${sessionId}`);

    let markdownFiles = [];
    let missing = [];
    let markdownError;
    try {
      ({ markdownFiles, missing } = await existingMarkdown(sessionId, sessionDir));
    } catch (error) {
      // The session move is still useful; report that the markdown sweep was skipped.
      markdownError = String(error);
    }

    const hidden = await hideSession(sessionId);
    if (hidden.blocked === true || hidden.failed === true) {
      return errorResult(hidden.blocked === true ? 'in-use' : 'registry-failed', hidden.error, { sessionId });
    }

    const stamp = utcStamp();
    const trashRoot = join(trashDir, stamp);
    let sessionTrashedTo;
    try {
      await mkdir(trashRoot, { recursive: true });
      sessionTrashedTo = join(trashRoot, basename(sessionDir));
      await rename(sessionDir, sessionTrashedTo);
    } catch (error) {
      return errorResult('move-failed', `session hidden but its directory could not be moved: ${String(error)}`, {
        sessionId,
        sessionDir,
        archived: hidden.archived,
        detached: hidden.detached,
      });
    }

    const moved = [];
    const failed = [];
    for (const file of markdownFiles) {
      try {
        const target = join(trashRoot, 'md', trashRelativePath(file));
        if (!isInside(trashRoot, target)) throw new Error(`refusing to move outside the trash root: ${file}`);
        await mkdir(dirname(target), { recursive: true });
        await rename(file, target);
        moved.push({ from: file, to: target });
      } catch (error) {
        failed.push({ from: file, error: String(error) });
      }
    }

    invalidate(sessionId);
    return {
      ok: true,
      sessionId,
      sessionDir,
      sessionTrashedTo,
      trashRoot,
      archived: hidden.archived,
      detached: hidden.detached,
      warning: hidden.warning,
      markdownError,
      markdownCount: moved.length,
      markdownSkippedCount: failed.length + missing.length,
      markdownFiles: moved.map((entry) => entry.from),
      failed,
    };
  }

  return { findSessionDir, previewSession, purgeSession };
}

/** GET/HEAD preview: the markdown a confirming purge would move. */
async function previewFetch(request, purge) {
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? '';
  let result;
  try {
    result = await purge.previewSession(sessionId);
  } catch (error) {
    result = errorResult('internal', `preview failed: ${String(error)}`);
  }
  const status = result.ok === true ? 200 : statusForCode(result.code);
  const response = jsonResponse(result, status);
  if (request.method !== 'HEAD') return response;
  await response.body?.cancel();
  return new Response(null, { status, headers: response.headers });
}

/** POST purge: archive and move; the body carries one sessionId. */
async function purgeFetch(request, purge) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(errorResult('bad-request', 'invalid JSON body'), 400);
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  let result;
  try {
    result = await purge.purgeSession(sessionId);
  } catch (error) {
    result = errorResult('internal', `purge failed: ${String(error)}`);
  }
  return jsonResponse(result, result.ok === true ? 200 : statusForCode(result.code));
}

/**
 * Mount both routes on the authenticated Host Fetch bridge.
 *
 * `inject` above makes Cordis hold this plugin until the Connection service that
 * owns `/api` exists, so `ctx.get('connection')` is the bridge and not a
 * placeholder.
 *
 * @param ctx - Host context carrying Connection, Workspace registry and session-query.
 */
export function apply(ctx) {
  const connection = ctx.get('connection');
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    ctx.logger?.warn('session-purge: connection.fetch is unavailable; routes not mounted');
    return;
  }

  const purge = createSessionPurge({ getService: (name) => ctx.get(name) });

  ctx.effect(
    () =>
      connection.fetch.register({
        path: PREVIEW_PATH,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => previewFetch(request, purge),
      }),
    'session-purge: preview route',
  );

  ctx.effect(
    () =>
      connection.fetch.register({
        path: PURGE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => purgeFetch(request, purge),
      }),
    'session-purge: purge route',
  );
}

export const name = 'session-purge';

export const inject = ['connection'];

export { PREVIEW_PATH, PURGE_PATH };
