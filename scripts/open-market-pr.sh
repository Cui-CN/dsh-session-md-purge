#!/usr/bin/env bash
# Open the one-file pull request that lists this plugin in the community market
# catalog (awesome-dsh-plugin). dsh-market and awesome-dsh-plugin.com read it.
#
# The catalog requires the target repository to be at least one day old, so run
# this at least 24h after ./scripts/publish-github.sh created it.
#
# Usage:
#   ./scripts/open-market-pr.sh            # refuses before 24h
#   ./scripts/open-market-pr.sh --force    # open anyway (CI re-runs the age gate)
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="dsh-session-md-purge"
UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login -h github.com -p https -w" >&2
  exit 1
fi

LOGIN="$(gh api user --jq .login)"
URL="https://github.com/$LOGIN/$REPO"

# 1) The listing requires a repository at least one day old.
CREATED="$(gh api "repos/$LOGIN/$REPO" --jq .created_at)"
AGE_H="$(node -e 'console.log(Math.floor((Date.now() - Date.parse(process.argv[1])) / 36e5))' "$CREATED")"
echo "repository age: ${AGE_H}h"
if [ "$AGE_H" -lt 24 ] && [ "$FORCE" = 0 ]; then
  echo "The catalog requires a repository at least 24h old (currently ${AGE_H}h)." >&2
  echo "Re-run later, or pass --force: the submission gate re-runs by itself and turns green once the repo ages." >&2
  exit 1
fi

# 2) Fork and clone the catalog.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gh repo fork "$UPSTREAM" --clone=false --remote=false >/dev/null 2>&1 || true
git clone -q "https://github.com/$LOGIN/awesome-dsh-plugin.git" "$WORK/catalog"
cd "$WORK/catalog"
git checkout -q -b "add-$REPO"

# 3) Exactly one entry file; the READMEs are generated upstream.
mkdir -p data/plugins
cat > "data/plugins/${LOGIN}__${REPO}.yml" <<YAML
url: $URL
name: $LOGIN/$REPO
category: session
description:
  en: 'Adds a recoverable delete to the session context menu: the Host archives the session, detaches it from its project and moves the session directory plus the Markdown files that session wrote into \$DSH_HOME/session-trash; a session with running work is refused.'
  zh: '在会话右键菜单加入可恢复的“删除会话”：归档会话、解除项目归属，并把会话目录连同该会话写过的 Markdown 文件移入 \$DSH_HOME/session-trash；有运行中任务的会话会被拒绝。'
tarball: https://github.com/$LOGIN/$REPO/releases/latest/download/$REPO.tgz
YAML

git add "data/plugins/${LOGIN}__${REPO}.yml"
git -c user.name="$LOGIN" -c user.email="$LOGIN@users.noreply.github.com" commit -q -m "Add $LOGIN/$REPO"
git push -q -u origin "add-$REPO"

# 4) Open the PR with a body that points the reviewer at the claims they check.
gh pr create --repo "$UPSTREAM" --head "$LOGIN:add-$REPO" \
  --title "Add $LOGIN/$REPO" \
  --body "Adds $LOGIN/$REPO — a recoverable session delete.

What the plugin does (checked against the code):
- adds one \`删除会话\` context-menu action via \`ctx.contextMenus.register\` (menu closes first);
- \`GET /api/session.purge.preview\` lists the Markdown files the session wrote with \`write\`/\`edit\`/\`apply_patch\`;
- \`POST /api/session.purge\` archives the session through the Workspace registry, detaches it from its project and moves the session directory plus those Markdown files under \`\$DSH_HOME/session-trash/<UTC stamp>/\`;
- a session with running work is refused with HTTP 409 and left untouched;
- requires DSH >= 0.2.2-rc.1 (\`engines.dsh\`); no npm dependencies, no build step.

Source: $URL"

echo
echo "PR opened against $UPSTREAM."
