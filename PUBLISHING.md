# Publishing `dsh-session-md-purge` to the plugin market

Target: the community market — [dsh-market](https://github.com/dsh-market/dsh-market)
inside DSH plus [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com). Both read
the curated registry at `awesome-dsh-plugin/awesome-dsh-plugin`; getting listed
means one YAML entry file there. No npm account is required.

Replace every `Cui-CN` below with your GitHub username (case-sensitive) before
copying commands or files. `scripts/publish-github.sh` does that automatically.

## One-time: authenticate the GitHub CLI

Signing in at github.com in a browser does **not** give the CLI a credential. Run
once in a terminal:

```sh
gh auth login -h github.com -p https -w
```

Choose HTTPS for git operations and let it configure the credential helper. The
token is stored in `~/.config/gh/hosts.yml`, so every shell — including this
agent's — can use it afterwards.

## Automated path

```sh
cd /Users/hua/Documents/deepseek-harness/session-purge-plugin
./scripts/publish-github.sh          # fill Cui-CN, commit, create the public repo, push, add the dsh-plugin topic, cut the release tarball
# wait until the repository is 24h old (catalog rule)
./scripts/open-market-pr.sh          # fork the catalog, add data/plugins/<login>__dsh-session-md-purge.yml, open the PR
```

- `publish-github.sh --dry-run` prints who/what it would use without writing.
- `open-market-pr.sh --force` opens the PR before the 24h gate; the submission
  gate re-runs by itself and turns green once the repository ages past 24h.

The manual commands in the sections below are the same steps, kept for reference.

## 0. Requirements this repository already meets

- `package.json` declares `dsh.bundle` with `./cordis.patch.yml`, and that file
  exists at the repository root (the most common rejection reason).
- The package is real, working code with tests (`node --test test/*.test.js`).
- `engines.dsh` is `>=0.2.2-rc.1`, matching the API the plugin actually uses.
- No npm dependencies and no build step, so a source install does not need a
  build approval.
- MIT license, README, icon.

Still needed from you:

- a **public GitHub repository**, at least **1 day old** before the pull request
  (CI checks the repo age automatically),
- the GitHub topic **`dsh-plugin`**,
- a GitHub Release carrying a **prebuilt tarball** (recommended: storefronts then
  offer it instead of a source build).

## 1. Create the repository

```sh
cd /Users/hua/Documents/deepseek-harness/session-purge-plugin
git init
git add .
git commit -m "dsh-session-md-purge 1.5.0"
git branch -M main
git remote add origin git@github.com:Cui-CN/dsh-session-md-purge.git
git push -u origin main
```

Then add the topic (web UI or GitHub CLI):

```sh
gh repo edit Cui-CN/dsh-session-md-purge --add-topic dsh-plugin
```

`npm pack --dry-run` lists exactly what the package publishes; it must contain
`index.js`, `client.js`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`,
`README.md` and `LICENSE`.

## 2. Cut the release tarball

The release asset name must be **version-free** when it is addressed through
`releases/latest/download/`; otherwise the URL breaks on the next release.

```sh
npm pack
mkdir -p dist
cp dsh-session-md-purge-1.5.0.tgz dist/dsh-session-md-purge.tgz
gh release create v1.5.0 dist/dsh-session-md-purge.tgz \
  --title "dsh-session-md-purge 1.5.0" \
  --notes "Session delete that archives the session and moves the Markdown it wrote into a recoverable trash."
```

Resulting install source (works immediately, before any listing):

```sh
dsh plugin --profile <profile> add https://github.com/Cui-CN/dsh-session-md-purge/releases/latest/download/dsh-session-md-purge.tgz
```

## 3. Open one pull request to `awesome-dsh-plugin`

`git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`, then add
exactly one file — `data/plugins/Cui-CN__dsh-session-md-purge.yml`:

```yaml
url: https://github.com/Cui-CN/dsh-session-md-purge
name: Cui-CN/dsh-session-md-purge
category: session
description:
  en: 'Adds a recoverable delete to the session context menu: the Host archives the session, detaches it from its project and moves the session directory plus the Markdown files that session wrote into $DSH_HOME/session-trash; a session with running work is refused.'
  zh: '在会话右键菜单加入可恢复的“删除会话”：归档会话、解除项目归属，并把会话目录连同该会话写过的 Markdown 文件移入 $DSH_HOME/session-trash；有运行中任务的会话会被拒绝。'
tarball: https://github.com/Cui-CN/dsh-session-md-purge/releases/latest/download/dsh-session-md-purge.tgz
```

Notes:

- The description is checked against the code. This one states only what the
  plugin does: archive, detach, move session + Markdown, refuse running work,
  recoverable trash path.
- `category: session` is the "Sessions & Messages" section; a maintainer may
  re-file it and that is not a rejection.
- Do **not** edit the generated READMEs; the one YAML file is the whole
  submission.
- One PR may add at most 3 entries.
- Optional `icon:` must be a GitHub-hosted **raster** image (PNG/JPEG/WebP),
  about square; SVG is refused by the catalog. Without it the market falls back
  to your GitHub avatar.
- Optional screenshots: add `screenshots.json` next to `package.json` listing 1–8
  paths inside this repository, e.g.
  `["assets/screenshot-menu.png", "assets/screenshot-confirm.png"]`.

Wait until the repository is at least one day old, then open the PR. CI checks
the manifest, repo age, formatting and README regeneration; a maintainer then
reads the code. Usually it is merged and visible in dsh-market within a day.

## 4. What each market shows

| Surface | Needs |
| --- | --- |
| [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) list | merged YAML entry |
| dsh-market (community market UI) | merged YAML entry; installs from the tarball or GitHub source |
| Official Discover index (`plugin_market` tool, **Index sources**) | an npm-published version — the format-1 catalog only maps npm packages |

So GitHub-only is enough for the community market. If you later want the official
Discover/index surface and download counts, publish to npm:

```sh
npm publish --registry=https://registry.npmjs.org
```

`name` (`dsh-session-md-purge`) is currently free on npm, and `repository` must
point back at the same GitHub repository, or the catalog will not link the two.
The local `~/.npmrc` points at `registry.npmmirror.com`, which is a read-only
mirror — publishing needs the explicit `--registry` above.

## 5. Updating later

- New version: bump `package.json`, commit, `git tag vX.Y.Z`, push, create a
  release with the new version-free tarball. Existing users update through the
  market.
- The awesome entry rarely needs changes; it has no version field.

## 6. Competitive note

Three npm packages already do session deletion:
`dsh-session-purge`, `dsh-session-trash`, `dsh-delete-session`. None of them is in
the curated catalog, and this plugin's distinguishing behaviour is moving the
Markdown files the session itself wrote together with the session, plus the
Workspace-registry archive/detach flow and the running-work refusal. Keep the
description focused on that instead of "better deletion".
