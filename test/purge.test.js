/**
 * Offline tests for the session-purge Host half.
 *
 * The plugin is exercised through the same two seams the running Harness uses:
 *
 * - `createSessionPurge({ home, getService })` for the file and registry work,
 * - `apply(ctx)` with a fake Connection whose `fetch.register` captures the two
 *   route descriptors, then calling `route.fetch(request)` exactly as the `/api`
 *   bridge does.
 *
 * A fake `sessionQuery` and a plain `.jsonl` log keep the suite independent of
 * the `zstd` binary and of the real session store.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = await mkdtemp(join(tmpdir(), 'dsh-session-purge-test-'));
process.env.DSH_HOME = HOME;

const {
  PREVIEW_PATH,
  PURGE_PATH,
  apply,
  createSessionPurge,
  markdownPathFromEvent,
  markdownPathsFromEvents,
  markdownPathsFromLogText,
} = await import('../index.js');

test.after(async () => {
  await rm(HOME, { recursive: true, force: true });
});

let sequence = 0;

/** One `tool/call` log line for the given tool and JSON arguments. */
function toolCall(name, args) {
  sequence += 1;
  return JSON.stringify({
    type: 'tool/call',
    seq: sequence,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: `call-${sequence}`, name, arguments: JSON.stringify(args) },
  });
}

/** Materialize a session directory (and its markdown files) under the test home. */
async function makeSession({ id, workspace = 'ws-a', lines = [], mdFiles = {} } = {}) {
  const dir = join(HOME, 'sessions', workspace, id);
  await mkdir(dir, { recursive: true });
  if (lines.length > 0) await writeFile(join(dir, 'session.v4.jsonl'), `${lines.join('\n')}\n`);
  for (const [filePath, content] of Object.entries(mdFiles)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

/** A Workspace registry stub recording the archive and detach calls. */
function fakeRegistry({ active = false, throwsName } = {}) {
  const calls = { archived: [], detached: [] };
  const registry = {
    archivedSessionIds: [],
    async archiveSession(sessionId) {
      if (throwsName !== undefined) {
        const error = new Error(throwsName);
        error.name = throwsName;
        error.activity = [{ kind: 'turn' }, { kind: 'subagent' }];
        throw error;
      }
      if (active) {
        const error = new Error('active');
        error.name = 'WorkspaceActiveSessionError';
        error.activity = [{ kind: 'turn' }];
        throw error;
      }
      calls.archived.push(sessionId);
      registry.archivedSessionIds.push(sessionId);
    },
    list() {
      return [
        {
          sessionIds: ['session-other'],
          async detachSession() {
            throw new Error('must not detach an unrelated session');
          },
        },
        {
          sessionIds: [registry.targetId],
          async detachSession(sessionId) {
            calls.detached.push(sessionId);
          },
        },
      ];
    },
    calls,
    targetId: undefined,
  };
  return registry;
}

/** Mount the plugin on a fake Host context and return the captured routes. */
function mount(getService = () => undefined) {
  const routes = [];
  const ctx = {
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
        };
      }
      return getService(name);
    },
    effect(fn) {
      fn();
    },
    logger: { warn() {} },
  };
  apply(ctx);
  return routes;
}

function jsonResponseBody(response) {
  return response.json();
}

test('markdownPathFromEvent accepts stored envelopes and parsed arguments', () => {
  const stored = JSON.parse(toolCall('write', { file_path: join(HOME, 'notes', 'a.md') }));
  assert.equal(markdownPathFromEvent(stored), join(HOME, 'notes', 'a.md'));

  const parsed = { type: 'tool/call', data: { name: 'apply_patch', arguments: { path: join(HOME, 'notes', 'b.md') } } };
  assert.equal(markdownPathFromEvent(parsed), join(HOME, 'notes', 'b.md'));

  assert.equal(markdownPathFromEvent({ type: 'tool/result', data: { name: 'write' } }), undefined);
  assert.equal(markdownPathFromEvent({ type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"x.md"}' } }), undefined);
  assert.equal(markdownPathFromEvent({ type: 'tool/call', data: { name: 'write', arguments: 'not json' } }), undefined);
  assert.equal(markdownPathFromEvent({ type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"/etc/x.md"}' } }), undefined);
});

test('application data and dependency trees are never swept into the trash', () => {
  const write = (filePath) => ({ type: 'tool/call', data: { name: 'write', arguments: { file_path: filePath } } });
  assert.equal(markdownPathFromEvent(write(join(homedir(), 'Library', 'x.md'))), undefined);
  assert.equal(markdownPathFromEvent(write(join(homedir(), '.dsh', 'x.md'))), undefined);
  assert.equal(markdownPathFromEvent(write(join(homedir(), '.config', 'x.md'))), undefined);
  assert.equal(markdownPathFromEvent(write(join(homedir(), 'project', 'node_modules', 'pkg', 'x.md'))), undefined);
  assert.equal(markdownPathFromEvent(write(join(homedir(), 'Documents', 'report.md'))), join(homedir(), 'Documents', 'report.md'));
});

test('a preview re-scans once the session log grows', async () => {
  const sessionId = 'session-cache';
  const first = join(HOME, 'notes', 'cache-a.md');
  const second = join(HOME, 'notes', 'cache-b.md');
  await makeSession({
    id: sessionId,
    lines: [toolCall('write', { file_path: first })],
    mdFiles: { [first]: '# a', [second]: '# b' },
  });

  const purge = createSessionPurge({ home: HOME });
  assert.deepEqual((await purge.previewSession(sessionId)).markdownFiles, [first]);

  const logFile = join(HOME, 'sessions', 'ws-a', sessionId, 'session.v4.jsonl');
  await appendFile(logFile, `${toolCall('write', { file_path: second })}\n`);

  assert.deepEqual((await purge.previewSession(sessionId)).markdownFiles, [first, second]);
});

test('markdownPathsFromLogText collects md paths from write/edit/apply_patch exactly once', () => {
  const a = join(HOME, 'notes', 'a.md');
  const b = join(HOME, 'notes', 'b.MD');
  const text = [
    toolCall('write', { file_path: a }),
    toolCall('edit', { file_path: a }),
    toolCall('apply_patch', { path: b }),
    toolCall('write', { file_path: join(HOME, 'notes', 'c.txt') }),
    toolCall('read', { file_path: join(HOME, 'notes', 'd.md') }),
    '',
    'not json at all',
    '{ "type": "tool/call", "data": { "name": "write", "arguments": "not json" } }',
  ].join('\n');

  assert.deepEqual(markdownPathsFromLogText(text), [a, b]);
});

test('markdownPathsFromEvents ignores non-array input', () => {
  assert.deepEqual(markdownPathsFromEvents(undefined), []);
  assert.deepEqual(markdownPathsFromEvents(null), []);
});

test('preview lists existing markdown and reports missing files separately', async () => {
  const sessionId = 'session-preview';
  const existing = join(HOME, 'notes', 'preview.md');
  const missing = join(HOME, 'notes', 'preview-gone.md');
  await makeSession({
    id: sessionId,
    lines: [toolCall('write', { file_path: existing }), toolCall('write', { file_path: missing })],
    mdFiles: { [existing]: '# kept' },
  });

  const purge = createSessionPurge({ home: HOME });
  const result = await purge.previewSession(sessionId);

  assert.equal(result.ok, true);
  assert.deepEqual(result.markdownFiles, [existing]);
  assert.deepEqual(result.missing, [missing]);
  assert.equal(result.markdownBytes, 6);
  assert.equal(result.live, false);
  assert.equal(result.archived, false);
});

test('preview reports a missing session and rejects a malformed id', async () => {
  const purge = createSessionPurge({ home: HOME });
  assert.deepEqual(await purge.previewSession('session-does-not-exist'), {
    ok: false,
    code: 'not-found',
    error: 'session not found: session-does-not-exist',
  });
  assert.equal((await purge.previewSession('../etc/passwd')).code, 'bad-request');
});

test('purge archives, detaches, then moves the session and its markdown into trash', async () => {
  const sessionId = 'session-purge';
  const markdown = join(HOME, 'notes', 'purge.md');
  const sessionDir = await makeSession({
    id: sessionId,
    lines: [toolCall('write', { file_path: markdown })],
    mdFiles: { [markdown]: '# moved' },
  });

  const registry = fakeRegistry();
  registry.targetId = sessionId;
  const purge = createSessionPurge({
    home: HOME,
    getService: (name) => (name === 'workspaceRegistry' ? registry : undefined),
  });

  const result = await purge.purgeSession(sessionId);

  assert.equal(result.ok, true);
  assert.deepEqual(registry.calls.archived, [sessionId]);
  assert.deepEqual(registry.calls.detached, [sessionId]);
  assert.equal(result.archived, true);
  assert.equal(result.detached, true);
  assert.equal(existsSync(sessionDir), false);
  assert.equal(existsSync(markdown), false);
  assert.equal(result.sessionTrashedTo.startsWith(join(HOME, 'session-trash')), true);
  assert.equal(result.markdownCount, 1);
  assert.equal(result.markdownFiles[0], markdown);
  const trashed = join(result.trashRoot, 'md', markdown.replace(/^\/+/u, ''));
  assert.equal(await readFile(trashed, 'utf8'), '# moved');
  assert.equal(existsSync(result.sessionTrashedTo), true);
});

test('purge refuses a session with running work and moves nothing', async () => {
  const sessionId = 'session-busy';
  const markdown = join(HOME, 'notes', 'busy.md');
  const sessionDir = await makeSession({
    id: sessionId,
    lines: [toolCall('write', { file_path: markdown })],
    mdFiles: { [markdown]: '# busy' },
  });

  const purge = createSessionPurge({
    home: HOME,
    getService: (name) => (name === 'workspaceRegistry' ? fakeRegistry({ active: true }) : undefined),
  });

  const result = await purge.purgeSession(sessionId);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'in-use');
  assert.match(result.error, /running|运行/u);
  assert.equal(existsSync(sessionDir), true);
  assert.equal(existsSync(markdown), true);
});

test('purge falls back to session-query events when the log cannot be read', async () => {
  const sessionId = 'session-query';
  const markdown = join(HOME, 'notes', 'query.md');
  const sessionDir = join(HOME, 'sessions', 'ws-a', sessionId);
  await mkdir(sessionDir, { recursive: true });
  // A log that exists but is not readable as plain JSONL makes the log path throw.
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'not zstd at all');
  await mkdir(dirname(markdown), { recursive: true });
  await writeFile(markdown, '# from query');

  const sessionQuery = {
    async readSession() {
      return { events: [{ type: 'tool/call', data: { name: 'write', arguments: { file_path: markdown } } }] };
    },
  };
  const purge = createSessionPurge({
    home: HOME,
    getService: (name) => (name === 'sessionQuery' ? sessionQuery : undefined),
  });

  const result = await purge.purgeSession(sessionId);

  assert.equal(result.ok, true);
  assert.equal(existsSync(markdown), false);
  assert.equal(result.markdownCount, 1);
});

test('apply mounts two authenticated exact Fetch routes with no raw Node handler', () => {
  const routes = mount();
  assert.equal(routes.length, 2);
  for (const route of routes) {
    assert.equal(route.handler, undefined, 'a raw (req, res) handler would hang the request');
    assert.equal(typeof route.fetch, 'function');
    assert.equal(route.requestBody, 'buffered');
  }
  const preview = routes.find((route) => route.path === PREVIEW_PATH);
  assert.deepEqual(preview.methods, ['GET', 'HEAD']);
  const purge = routes.find((route) => route.path === PURGE_PATH);
  assert.deepEqual(purge.methods, ['POST']);
});

test('the preview route answers a Fetch request with JSON and an empty HEAD body', async () => {
  const sessionId = 'session-route-preview';
  const markdown = join(HOME, 'notes', 'route.md');
  await makeSession({
    id: sessionId,
    lines: [toolCall('write', { file_path: markdown })],
    mdFiles: { [markdown]: '# route' },
  });
  const routes = mount();
  const preview = routes.find((route) => route.path === PREVIEW_PATH);
  const url = `http://127.0.0.1:1${PREVIEW_PATH}?sessionId=${sessionId}`;

  const response = await preview.fetch(new Request(url));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/u);
  const body = await jsonResponseBody(response);
  assert.equal(body.ok, true);
  assert.deepEqual(body.markdownFiles, [markdown]);

  const head = await preview.fetch(new Request(url, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const missing = await preview.fetch(new Request(`http://127.0.0.1:1${PREVIEW_PATH}?sessionId=session-nope`));
  assert.equal(missing.status, 404);
  assert.equal((await jsonResponseBody(missing)).code, 'not-found');
});

test('the purge route validates its body and maps an active session to 409', async () => {
  const sessionId = 'session-route-purge';
  const markdown = join(HOME, 'notes', 'route-purge.md');
  const sessionDir = await makeSession({
    id: sessionId,
    lines: [toolCall('write', { file_path: markdown })],
    mdFiles: { [markdown]: '# route purge' },
  });
  const routes = mount((name) => (name === 'workspaceRegistry' ? fakeRegistry({ active: true }) : undefined));
  const purge = routes.find((route) => route.path === PURGE_PATH);

  const noBody = await purge.fetch(new Request(`http://127.0.0.1:1${PURGE_PATH}`, { method: 'POST' }));
  assert.equal(noBody.status, 400);

  const invalidBody = await purge.fetch(
    new Request(`http://127.0.0.1:1${PURGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }),
  );
  assert.equal(invalidBody.status, 400);

  const busy = await purge.fetch(
    new Request(`http://127.0.0.1:1${PURGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  );
  assert.equal(busy.status, 409);
  assert.equal((await jsonResponseBody(busy)).code, 'in-use');
  assert.equal(existsSync(sessionDir), true);

  const unknown = await purge.fetch(
    new Request(`http://127.0.0.1:1${PURGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-nope' }),
    }),
  );
  assert.equal(unknown.status, 404);
});

test('purge works through the route with no registry service at all', async () => {
  const sessionId = 'session-route-no-registry';
  const markdown = join(HOME, 'notes', 'no-registry.md');
  const sessionDir = await makeSession({
    id: sessionId,
    lines: [toolCall('write', { file_path: markdown })],
    mdFiles: { [markdown]: '# no registry' },
  });
  const routes = mount();
  const purge = routes.find((route) => route.path === PURGE_PATH);

  const response = await purge.fetch(
    new Request(`http://127.0.0.1:1${PURGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }),
  );

  assert.equal(response.status, 200);
  const body = await jsonResponseBody(response);
  assert.equal(body.ok, true);
  assert.equal(body.archived, false);
  assert.match(body.warning, /registry unavailable/u);
  assert.equal(existsSync(sessionDir), false);
  assert.equal(existsSync(markdown), false);
});

test('the client registers one danger session action instead of a legacy menu component', async () => {
  let definition;
  globalThis.window = { __ModuleLoader__: { load: (loaded) => { definition = loaded; } } };
  try {
    await import('../client.js');
  } finally {
    delete globalThis.window;
  }

  assert.equal(definition.id, 'dsh-session-md-purge');
  const mod = definition.factory();
  assert.deepEqual(mod.inject, ['contextMenus']);

  const registrations = [];
  const notices = [];
  const ctx = {
    get: (name) =>
      name === 'contextMenus'
        ? {
            register: (input) => {
              registrations.push(input);
              return () => {};
            },
            notify: (text, success) => notices.push({ text, success }),
          }
        : undefined,
    effect: (fn) => fn(),
    logger: { warn() {} },
  };
  mod.apply(ctx);

  assert.equal(registrations.length, 1);
  const [registration] = registrations;
  assert.equal(registration.id, 'session-purge.delete');
  assert.equal(registration.target, 'session');
  assert.equal(registration.order, 500);

  const actions = registration.resolve({ sessionId: 'session-x', displayTitle: 'X' });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'delete');
  assert.equal(actions[0].label, '删除会话');
  assert.equal(actions[0].danger, true);
  assert.equal(actions[0].separatorBefore, true);
  assert.equal(typeof actions[0].run, 'function');
  assert.deepEqual(registration.resolve({ displayTitle: 'no id' }), []);
  assert.equal(notices.length, 0);
});
