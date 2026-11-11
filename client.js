/**
 * Client half of the session-purge bundle.
 *
 * Contributes one danger data action to the Session context menu through
 * `ctx.contextMenus.register`. A data action is resolved by the shared menu
 * overlay and, when selected, the overlay dismisses the menu *before* it runs
 * the action's `run` callback. That ordering is what keeps no menu remnant on
 * screen while the preview request, the confirmation dialog and the purge
 * request are in flight.
 *
 * The action flow is unchanged from the Host's point of view:
 *
 * 1. GET /api/session.purge.preview?sessionId=... lists what would move,
 * 2. a native confirm shows that list,
 * 3. POST /api/session.purge archives the session and moves it plus those
 *    markdown files into the recoverable trash.
 *
 * Every request carries an AbortSignal timeout, and failures surface through
 * the context-menu toast (`failureLabel` / `notify`) instead of a stuck menu
 * row. Both routes live on the authenticated `/api` bridge, so the browser
 * cookie is the only credential and `credentials: 'same-origin'` is enough.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-md-purge',
  factory() {
    const PREVIEW_ROUTE = '/api/session.purge.preview';
    const PURGE_ROUTE = '/api/session.purge';
    const REQUEST_TIMEOUT_MS = 30_000;
    const ACTION_PROVIDER_ID = 'session-purge.delete';
    const ACTION_LABEL = '删除会话';
    const FAILURE_LABEL = '删除会话失败，请重试或查看 DSH 日志';

    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return { ok: false, error: `HTTP ${response.status}` };
      }
    }

    function failureMessage(response, result) {
      if (response.status === 401 || response.status === 403) {
        return '登录状态已失效，请刷新页面后重试。';
      }
      if (result && typeof result.error === 'string' && result.error !== '') return result.error;
      return `请求失败（HTTP ${response.status}）。`;
    }

    async function requestJson(route, init) {
      const response = await fetch(route, {
        ...init,
        credentials: 'same-origin',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const result = await readJson(response);
      if (!response.ok || result.ok !== true) {
        throw new Error(failureMessage(response, result));
      }
      return result;
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const value = bytes / 1024 ** exponent;
      return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
    }

    /** Shorten a Host error for the menu toast, which shows one line. */
    function shortMessage(message) {
      const text = typeof message === 'string' ? message.trim() : String(message);
      return text.length > 120 ? `${text.slice(0, 118)}…` : text;
    }

    /** Report a failure through the shared menu toast; fall back to a dialog. */
    function reportFailure(ctx, message) {
      const menus = ctx.get('contextMenus');
      if (menus !== undefined && typeof menus.notify === 'function') {
        menus.notify(shortMessage(message), false);
        return;
      }
      window.alert(shortMessage(message));
    }

    /**
     * Ask the Host what would move, confirm with the user, then ask the Host to
     * archive and move. Runs after the menu has already been dismissed, so every
     * dialog below is the only visible surface.
     */
    async function deleteSession(ctx, target) {
      const sessionId = target?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      const displayTitle = typeof target.displayTitle === 'string' ? target.displayTitle : '';

      let preview;
      try {
        preview = await requestJson(`${PREVIEW_ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
          method: 'GET',
        });
      } catch (error) {
        reportFailure(ctx, error instanceof Error ? error.message : String(error));
        return;
      }

      const markdownFiles = Array.isArray(preview.markdownFiles) ? preview.markdownFiles : [];
      const lines = [
        `确定删除会话「${displayTitle || sessionId}」？`,
        '',
        '会话目录会移到 ~/.dsh/session-trash/，可在文件系统中手动恢复。',
      ];
      if (preview.live === true) {
        lines.push('该会话当前仍处于打开状态，删除后需要刷新页面。');
      }
      if (preview.archived === true) {
        lines.push('该会话已在归档区，本次删除会同时清掉它的文件。');
      }
      lines.push('', '删除后无法从侧栏直接撤销。');
      if (markdownFiles.length > 0) {
        lines.push(
          '',
          `将一并移入回收站的 MD 文件（${markdownFiles.length} 个，共 ${formatBytes(preview.markdownBytes)}）：`,
        );
        for (const file of markdownFiles) lines.push(`  • ${file}`);
      } else {
        lines.push('', '该会话没有产生 MD 文件。');
      }

      if (!window.confirm(lines.join('\n'))) return;

      let result;
      try {
        result = await requestJson(PURGE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
      } catch (error) {
        reportFailure(ctx, error instanceof Error ? error.message : String(error));
        return;
      }

      const summary = [
        '已移入回收站：',
        `会话：${result.sessionTrashedTo}`,
        result.markdownCount > 0
          ? `MD 文件：${result.markdownCount} 个${
              result.markdownSkippedCount > 0 ? `（${result.markdownSkippedCount} 个缺失或失败，已跳过）` : ''
            }`
          : 'MD 文件：无',
        `回收站根目录：${result.trashRoot}`,
      ];
      if (typeof result.warning === 'string') summary.push(`提示：${result.warning}`);
      if (result.archived === false) summary.push('侧栏可能仍显示该会话，刷新页面后会消失。');
      window.alert(summary.join('\n'));
    }

    return {
      inject: ['contextMenus'],
      apply(ctx) {
        const menus = ctx.get('contextMenus');
        if (menus === undefined || typeof menus.register !== 'function') {
          ctx.logger?.warn('session-purge: contextMenus service is unavailable; delete action not registered');
          return;
        }

        ctx.effect(
          () =>
            menus.register({
              id: ACTION_PROVIDER_ID,
              target: 'session',
              // Between "copy Session ID" (450) and the footer archive (600).
              order: 500,
              resolve: (target) => {
                if (typeof target?.sessionId !== 'string' || target.sessionId.length === 0) return [];
                return [
                  {
                    id: 'delete',
                    label: ACTION_LABEL,
                    danger: true,
                    separatorBefore: true,
                    failureLabel: FAILURE_LABEL,
                    run: () => deleteSession(ctx, target),
                  },
                ];
              },
            }),
          'session-purge: delete action',
        );
      },
    };
  },
});
