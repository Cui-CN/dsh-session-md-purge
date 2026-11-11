# dsh-session-md-purge

A DeepSeek Harness (DSH) plugin that makes deleting a session recoverable and
cleans up the Markdown that session wrote.

It adds one red **删除会话** action to the session context menu. Selecting it:

1. asks the Host which Markdown files the session wrote with the `write`,
   `edit` or `apply_patch` tools, and shows that list in a confirmation dialog;
2. archives the session through the Workspace registry — the durable archive set
   is what hides a sidebar row, and it also refuses a session with running work;
3. detaches the session from its project;
4. moves the session directory and those Markdown files under
   `$DSH_HOME/session-trash/<UTC stamp>/`.

Nothing is hard-deleted, so a mistake can be undone by hand from the trash folder.
A session with a running turn, subagent, task or active reminder is refused with
HTTP 409 and left untouched.

## Requirements

- DSH **0.2.2-rc.1 or newer** (`engines.dsh`). The plugin needs the
  authenticated `connection.fetch` Host bridge and the Workspace registry
  archive/detach API.
- No npm dependencies. The optional `zstd` binary is used as a fast path to read
  the session log; without it the plugin falls back to the Host's session-query
  service.

## Install

From a DSH profile, install the package from this repository:

```sh
dsh plugin --profile <profile> add github:Cui-CN/dsh-session-md-purge
```

Or use the prebuilt release tarball (no build step, no dependency install):

```sh
dsh plugin --profile <profile> add https://github.com/Cui-CN/dsh-session-md-purge/releases/latest/download/dsh-session-md-purge.tgz
```

In DSH Desktop, install through the app's plugin manager with the same source.
Once the plugin market lists this repository, it can also be installed from the
market UI.

After installing, refresh the page once so the client bundle loads. The action
then appears in the session context menu.

## What stays behind

```
$DSH_HOME/session-trash/<UTC stamp>/
  <session directory>          # moved as-is: log, lock and any other files
  md/<absolute path without the filesystem root>
```

For example `$HOME/Documents/report.md` lands at
`session-trash/<stamp>/md/Users/<name>/Documents/report.md`, and a Windows
`C:\Users\<name>\Documents\report.md` lands at
`session-trash/<stamp>/md/Users/<name>/Documents/report.md`. Restoring is a
plain file move; the archived session can be unarchived from the market/plugin
UI or the workspace registry.

## Client menu contract

The action is a data action, not a legacy component contribution:
`ctx.contextMenus.register({ id, target: 'session', order, resolve })` returns
`{ id: 'delete', label, danger: true, separatorBefore: true, failureLabel, run }`.
The shared overlay dismisses the menu before calling `run`, so no menu remnant
stays on screen while the preview request and the confirmation dialog run.
Failures surface through `ctx.contextMenus.notify(...)`.

The bundle declares `dsh.client.inject` for
`@deepseek-ai/dsh-client-ui-context-menu` and
`@deepseek-ai/dsh-client-ui-workspace`.

## Host routes

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/session.purge.preview` | `GET`, `HEAD` | Existing Markdown files, their total size, and `live` / `archived` flags |
| `/api/session.purge` | `POST` | `{ "sessionId": "..." }`; archive, detach, move |

Both are registered on `ctx.connection.fetch` (`requestBody: 'buffered'`), so the
`/api` bridge performs browser/API authentication, Host/Origin trust checks and
body limits, and the handler receives a Fetch `Request` and returns a Fetch
`Response`. The routes answer `400` for a bad body or id, `404` for an unknown
session, `409` for a session with running work, and `500` when the registry or
the file move fails.

## Scope and safety rails

- Only `.md` files named by this session's own `write`/`edit`/`apply_patch` calls
  are candidates, and only when they resolve under `$HOME`, `/tmp`,
  `/private/tmp` or `/var/folders` (or under `$HOME` on Windows).
- Application data and dependency trees are excluded even under `$HOME`:
  `Library`, `.dsh`, `.Trash`, `.config`, `.cache`, `.local`, `.npm`,
  `.pnpm-store`, plus any `node_modules` or `.git` segment.
- The confirmation dialog lists every file that will move before anything
  happens.
- A session with running work is refused; the Workspace registry archive gate is
  what enforces this.
- The compressed-log decompressor runs with a 20 s timeout, so a wedged `zstd`
  child fails the request instead of holding the route open.
- The preview caches its scan keyed by the log's `mtime`+size (at most 60 s), so
  the confirming click does not decompress the log twice and a stale list is
  never used after the log grows.
- The client request uses a 30 s `AbortSignal.timeout`.

## Tests

```sh
node --test test/*.test.js
```

The suite fakes the Connection Fetch router, Workspace registry and session-query
services, and runs against a temporary `$DSH_HOME`; it never touches real
sessions.

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the plugin-market listing steps.

## License

MIT
