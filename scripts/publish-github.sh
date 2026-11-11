#!/usr/bin/env bash
# Publish this plugin as a public GitHub repository and cut the release tarball
# the plugin market installs.
#
# Prerequisite (the browser login is not enough — the CLI has its own credential):
#   gh auth login -h github.com -p https -w
#
# Usage:
#   ./scripts/publish-github.sh            # publish (idempotent)
#   ./scripts/publish-github.sh --dry-run  # show the plan only
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="dsh-session-md-purge"
VERSION="$(node -p "require('./package.json').version")"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login -h github.com -p https -w" >&2
  exit 1
fi

LOGIN="$(gh api user --jq .login)"
echo "GitHub user: $LOGIN"
echo "Package:     $REPO $VERSION"
[ "$DRY_RUN" = 1 ] && { echo "dry run: nothing written"; exit 0; }

# Fill the OWNER placeholder once; later runs are no-ops.
for file in package.json README.md PUBLISHING.md; do
  if grep -q 'OWNER' "$file"; then
    sed -i.ownerbak "s/OWNER/$LOGIN/g" "$file"
    rm -f "$file.ownerbak"
    echo "updated $file"
  fi
done

git init -q 2>/dev/null || true
git config user.name "$LOGIN"
git config user.email "$LOGIN@users.noreply.github.com"

# Rebuild the release tarball from the final manifest; the asset name stays
# version-free so releases/latest/download/ never rots.
npm pack >/dev/null
rm -rf dist
mkdir -p dist
mv "$REPO-$VERSION.tgz" "dist/$REPO.tgz"

git add -A
git commit -m "$REPO $VERSION" 2>/dev/null || echo "nothing new to commit"
git branch -M main

if ! gh repo view "$LOGIN/$REPO" >/dev/null 2>&1; then
  gh repo create "$LOGIN/$REPO" --public \
    --description "DSH plugin: recoverable session delete that also archives the Markdown files the session wrote." \
    --source . --remote origin --push
else
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$LOGIN/$REPO.git"
  git push -u origin main
fi

gh repo edit "$LOGIN/$REPO" --add-topic dsh-plugin --add-topic deepseek-harness

if gh release view "v$VERSION" -R "$LOGIN/$REPO" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "dist/$REPO.tgz" -R "$LOGIN/$REPO" --clobber
else
  gh release create "v$VERSION" "dist/$REPO.tgz" -R "$LOGIN/$REPO" \
    --title "$REPO $VERSION" \
    --notes "Recoverable session delete: archive the session, detach it from its project, and move the session directory plus the Markdown files it wrote into \$DSH_HOME/session-trash. Running sessions are refused."
fi

echo
echo "Repository: https://github.com/$LOGIN/$REPO"
echo "Install:    dsh plugin --profile <profile> add https://github.com/$LOGIN/$REPO/releases/latest/download/$REPO.tgz"
echo "Market PR:  ./scripts/open-market-pr.sh  (after the repository is at least one day old)"
