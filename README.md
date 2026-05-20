# Ralph — Autonomous Claude Code Loop

Ralph drives [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) against a target repository in an iterating implementer → reviewer pipeline, isolated inside a custom Docker image. The harness ships as two npm packages, with thin bash shims that wire host paths + credentials into the CLI.

- **[`@daonhan/ralph-core`](./packages/core)** — library: iteration loop, docker runner, template renderer, stage registry. Importable from any Node project.
- **[`@daonhan/ralph`](./apps/cli)** — CLI: exposes `ralph-afk` and `ralph-ghafk` bin entries. Depends on `@daonhan/ralph-core`.

Two AFK entry points (both installed globally after `npm i -g @daonhan/ralph`):

- **`ralph-afk`** — plan/PRD-driven loop. Hand it a plan + PRD string; iterates until the agent emits `NO MORE TASKS`.
- **`ralph-ghafk`** — GitHub-issue-driven loop. Pulls open issues with `gh issue list` and lets the agent pick the next AFK task.

Convenience shims live at [`apps/cli/scripts/afk.sh`](./apps/cli/scripts/afk.sh) and [`apps/cli/scripts/ghafk.sh`](./apps/cli/scripts/ghafk.sh) — thin wrappers that fall back to `npx @daonhan/ralph` if not installed.

Agent playbooks: [`packages/core/templates/prompt.md`](./packages/core/templates/prompt.md) (for `ralph-afk`) and [`packages/core/templates/ghprompt.md`](./packages/core/templates/ghprompt.md) (for `ralph-ghafk`). Reviewer instructions: [`packages/core/templates/review.md`](./packages/core/templates/review.md). All three ship inside `@daonhan/ralph-core`.

---

## Architecture (AFK loops)

```
ralph-afk / ralph-ghafk               (bin entries from @daonhan/ralph, on PATH after `npm i -g`)
   │
   ▼
@daonhan/ralph (CLI, apps/cli)        bin: ralph-afk, ralph-ghafk; scripts: afk.sh, ghafk.sh shims
   │ imports
   ▼
@daonhan/ralph-core (packages/core)
   ├── runAfk / runGhAfk              (env-driven entry: argv → runLoop)
   ├── runLoop                        (drives stage chain per iteration; checks sentinel)
   ├── render                         (template renderer: !`cmd` + {{ INPUTS }})
   ├── stages                         (stage registry: implementer, ghafkImplementer, reviewer)
   └── runner                         (docker run → NDJSON stream → live print → final result)
   │
   ▼
docker run ralph-sandbox claude --verbose --print --output-format stream-json …
```

Each iteration runs the stage chain `[implementer, reviewer]`. The implementer is the "gate": if it emits `<promise>NO MORE TASKS</promise>`, the loop exits before the reviewer runs.

Prompt templates use two expansion forms:

- `` !`<shell cmd>` `` — executed on the host before each iteration; output replaces the tag.
- `{{ INPUTS }}` — replaced with the entry CLI's input arg (plan/PRD string for `ralph-afk`; empty for `ralph-ghafk`).

---

## Repo layout

```
ralph/
├── package.json                 monorepo root (private, shared devDeps, pnpm scripts)
├── pnpm-workspace.yaml
├── tsconfig.base.json           shared TS compiler options
├── .npmrc                       link-workspace-packages, prefer-workspace-packages
├── .dockerignore                shrinks build context (consumed at repo root)
├── apps/
│   └── cli/                     @daonhan/ralph
│       ├── package.json
│       ├── bin/
│       │   ├── ralph-afk.js
│       │   └── ralph-ghafk.js
│       └── scripts/             optional bash shims (ship in npm tarball)
│           ├── afk.sh
│           └── ghafk.sh
├── packages/
│   └── core/                    @daonhan/ralph-core
│       ├── package.json
│       ├── tsconfig.json
│       ├── Dockerfile           builds ralph-sandbox image (Node + .NET + gh + claude)
│       ├── src/                 main.ts, gh-main.ts, loop.ts, runner.ts, render.ts, stages.ts, index.ts
│       └── templates/           afk.md, ghafk.md, review.md
└── (playbooks live in packages/core/templates/ alongside the prompt templates)
```

At runtime, the host workspace gets a `.ralph-tmp/` directory containing the per-iteration prompt files and `logs/*.ndjson`. This directory is gitignored.

---

## Prerequisites

- **WSL / Bash** on Windows. PowerShell cannot run the shims; call them through `wsl bash …`.
- **Docker** (Docker Desktop with WSL2 backend, or Docker Engine in WSL). The orchestrator shells out to `docker build` / `docker run`.
- **Node.js 20+** on the host (Linux side under WSL).
- **pnpm 9+** (for monorepo development). End users consuming the published package can use `npm`, `pnpm`, or `yarn`.
- **`gh`** authenticated on the host (only `ralph-ghafk`): `gh auth login` once.
- **Claude Code** authentication. See "First-run setup" below.

### Windows + WSL: which `~` does Ralph use?

The shims execute under WSL, so `runner.ts` resolves `$HOME` to the **WSL Linux home** (`/home/<linuxname>`), not the Windows profile (`C:\Users\<name>`).

| Where you typed it | `~` resolves to | Used by |
| --- | --- | --- |
| PowerShell | `C:\Users\<name>` | `claude.exe` host installer — **ignored by Ralph** |
| WSL bash | `/home/<linuxname>` | **Ralph (ralph-afk / ralph-ghafk) — canonical credential store** |

Consequences:

- All `claude /login` and `gh auth login` for Ralph must happen under WSL (directly, or inside a WSL-launched container as in the next section).
- If you already logged in on the Windows side (`C:\Users\<you>\.claude\`), migrate the credentials into WSL once:
  ```bash
  # WSL bash — replace <WINUSER>
  mkdir -p ~/.claude
  cp -r /mnt/c/Users/<WINUSER>/.claude/. ~/.claude/
  cp /mnt/c/Users/<WINUSER>/.claude.json ~/.claude.json 2>/dev/null || true
  mkdir -p ~/.config/gh
  cp -r "/mnt/c/Users/<WINUSER>/AppData/Roaming/GitHub CLI/." ~/.config/gh/ 2>/dev/null || true
  ```
- To launch from PowerShell, always go through `wsl bash`:
  ```powershell
  wsl bash -c 'ralph-afk "<plan-and-prd>" 3'
  ```

---

## First-run setup

### 1. Get the image

The orchestrator resolves the image in three steps on each run:

1. `docker image inspect $RALPH_IMAGE` — short-circuits if the image is already on the host.
2. Otherwise `docker pull $RALPH_IMAGE` — defaults to `docker.io/daonhan/ralph-sandbox:latest`.
3. If pull fails AND `$RALPH_DOCKER_CONTEXT/Dockerfile` exists, falls back to `docker build -t $RALPH_IMAGE $RALPH_DOCKER_CONTEXT`.

For most users step 2 is enough — no local Dockerfile needed. To prime the cache:

```bash
docker pull docker.io/daonhan/ralph-sandbox:latest
```

Build locally (offline, custom changes):

```bash
cd ralph
docker build -t docker.io/daonhan/ralph-sandbox:latest -f packages/core/Dockerfile .
```

The image bundles: Node 22, .NET SDK 9, `gh`, `jq`, `git`, the Claude Code CLI.

#### Publishing a new image (maintainers)

The repo ships a GitHub Actions workflow at [`.github/workflows/publish-image.yml`](./.github/workflows/publish-image.yml) that builds + pushes multi-arch (`linux/amd64`, `linux/arm64`) images to Docker Hub.

Triggers:

- **`workflow_dispatch`** — manual run from the Actions tab; pick the tag and whether to also push `:latest`.
- **Git tag `image-v*`** — pushing a tag like `image-v0.1.3` publishes `:0.1.3` plus `:latest`.

Required repo secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (a Docker Hub access token with `Read & Write` scope on the `daonhan/ralph-sandbox` repository).

### 2. Log in to the image (one-off)

The image is stateless. Credentials live on the **host** at `~/.claude` and `~/.config/gh`. The orchestrator bind-mounts those paths into every container.

```bash
mkdir -p ~/.claude ~/.config/gh
touch ~/.claude.json

docker run -it --rm \
  -v "$HOME/.claude:/home/agent/.claude" \
  -v "$HOME/.claude.json:/home/agent/.claude.json" \
  -v "$HOME/.config/gh:/home/agent/.config/gh" \
  docker.io/daonhan/ralph-sandbox:latest bash
```

Inside the container:

```bash
claude /login         # browser flow
gh auth login         # only needed for ralph-ghafk
exit
```

Verify back on the host:

```bash
ls -la ~/.claude/.credentials.json ~/.claude.json
cat ~/.config/gh/hosts.yml | head
```

#### Re-login / token expired

Re-run `claude /login` (or `gh auth login`) inside the container. Bind-mounted files are overwritten.

---

## `ralph-afk` — plan/PRD loop

### Usage

```bash
ralph-afk "<plan-and-prd>" <iterations>
```

(Or via the shim: `./node_modules/@daonhan/ralph/scripts/afk.sh "<plan-and-prd>" <iterations>`.)

Also supports:

- `ralph-afk --help` (or `-h`) — usage, flags, env vars.
- `ralph-afk --print-config` — print resolved workspace / docker context / image and exit. Use for diagnostics before launching a real loop.

- `<plan-and-prd>` — a single string forwarded verbatim as `{{ INPUTS }}` in the template. Conventionally paths to plan and PRD files.
- `<iterations>` — max loop iterations. Exits early if implementer emits the sentinel.

### Example

```bash
ralph-afk "./docs/plans/inventory.md ./docs/prd/PRD-Inventory.md" 10
```

From PowerShell on Windows:

```powershell
wsl bash -c "ralph-afk './docs/plans/inventory.md ./docs/prd/PRD-Inventory.md' 10"
```

### What happens per iteration

1. **Render template** `packages/core/templates/afk.md`:
   - `` !`git log -n 5 …` `` → recent commits
   - `{{ INPUTS }}` → the plan/PRD string
   - `@include:prompt.md` → the agent playbook (inlined by the Node renderer, no shell)
2. **Implementer stage** (gate) — `docker run ralph-sandbox claude …` with the rendered prompt streamed in via a tempfile under `.ralph-tmp/` (avoids Windows 32 KB argv limit). Assistant text is rendered live; final `result` is captured.
3. **Sentinel check** — if `result` contains `<promise>NO MORE TASKS</promise>`, print `Ralph complete after <N> iterations.` and exit 0.
4. **Reviewer stage** — runs `packages/core/templates/review.md`. Inspects HEAD diff. Either commits a `fix(review): …` patch or emits `<review>OK</review>` / `<review>SKIP</review>` and stops.

---

## `ralph-ghafk` — GitHub-issue loop

### Usage

```bash
ralph-ghafk <iterations>
```

No plan/PRD arg — context comes from open GitHub issues.

### What happens per iteration

1. **Render template** `packages/core/templates/ghafk.md`:
   - `` !`git log -n 5 …` `` → recent commits
   - `` !`gh issue list --state open --json number,title,body,comments` `` → open issues
   - `@include:ghprompt.md` → the agent playbook (inlined by the Node renderer, no shell)
2. **ghafk-implementer stage** (gate) — agent picks one open AFK issue, implements it, commits, closes / comments on the issue.
3. **Sentinel check** — same as `ralph-afk`.
4. **Reviewer stage** — same as `ralph-afk`.

---

## Consuming the package in another repo

### Global install (recommended — run from anywhere)

```bash
npm i -g @daonhan/ralph
```

After install, both bins are on your `$PATH`:

```bash
cd /path/to/some/workspace
ralph-afk "<plan-and-prd>" 5
ralph-ghafk 5
```

The bundled Dockerfile (shipped inside `@daonhan/ralph-core`) is the default `RALPH_DOCKER_CONTEXT`, so the `docker build` fallback works even when you invoke from a workspace that has no `Dockerfile` of its own.

### Per-repo install

```bash
# in your workspace repo
npm i -D @daonhan/ralph         # or: pnpm add -D @daonhan/ralph
./node_modules/.bin/ralph-afk "<plan-and-prd>" 5
```

### Bootstrap on demand (no install)

```bash
npx -y @daonhan/ralph ralph-afk "<plan-and-prd>" 5
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `RALPH_WORKSPACE` | `process.cwd()` | Host path bind-mounted at `/home/agent/workspace`. Also where `.ralph-tmp/` is written. |
| `RALPH_DOCKER_CONTEXT` | bundled `@daonhan/ralph-core` dir | Build context for the `docker build` fallback. Only consulted if `docker pull` fails. Must contain `Dockerfile`. Defaults to the npm-installed core dir, which ships `Dockerfile`. |
| `RALPH_IMAGE` | `docker.io/daonhan/ralph-sandbox:latest` | Full image reference. `ensureImage` does `inspect` → `pull` → `build` (fallback). |
| `RALPH_IMAGE_TAG` | _(legacy)_ | Deprecated alias for `RALPH_IMAGE`. Honored if `RALPH_IMAGE` unset. |

---

## Local development (this monorepo)

```bash
pnpm install                          # links workspace, hoists devDeps
pnpm -r build                         # compiles packages/core/dist
pnpm -r typecheck                     # no-emit type check
```

### Build artifacts

- `packages/core/dist/` — compiled `.js` + `.d.ts`. Required for both `pnpm pack` and `pnpm publish`.
- `apps/cli` has no build step — bin shims are hand-written JS.

### Pack tarballs (smoke-test before publish)

```bash
(cd packages/core && pnpm pack --pack-destination /tmp)
(cd apps/cli      && pnpm pack --pack-destination /tmp)

# Install both in a throwaway repo to verify the published artifacts work
mkdir /tmp/ralph-test && cd /tmp/ralph-test
npm init -y
npm i -D /tmp/daonhan-ralph-core-0.1.0.tgz /tmp/daonhan-ralph-0.1.0.tgz
./node_modules/.bin/ralph-afk           # → prints usage
```

### Global install from local checkout (dev shortcut)

`pnpm link --global` is brittle inside this workspace (pnpm 9 rewrites the dependent's manifest). Use the pack-then-install path instead:

```bash
pnpm -r build
(cd packages/core && pnpm pack --pack-destination /tmp/ralph-packs)
(cd apps/cli      && pnpm pack --pack-destination /tmp/ralph-packs)
npm i -g /tmp/ralph-packs/daonhan-ralph-core-0.1.0.tgz \
         /tmp/ralph-packs/daonhan-ralph-0.1.0.tgz
ralph-afk          # → Usage: ralph-afk <plan-and-prd> <iterations>
```

Re-run after each source change. To uninstall: `npm uninstall -g @daonhan/ralph @daonhan/ralph-core`.

### Publish

```bash
# Bump versions in packages/core/package.json and apps/cli/package.json first.
# pnpm publishes in topological order; workspace:^ specifiers are rewritten to semver.
pnpm -r publish --access public
```

Per-package publish (granular):

```bash
(cd packages/core && pnpm publish --access public)
(cd apps/cli      && pnpm publish --access public)
```

### Use a local checkout in another repo (no publish)

Use the pack-then-install path above. It exposes `ralph-afk` / `ralph-ghafk` globally; no per-workspace step needed.

---

## Customizing the pipeline

### Add a stage

1. Add an entry to `STAGES` in `packages/core/src/stages.ts`:
   ```ts
   linter: { name: "linter", template: "lint.md", permissionMode: "acceptEdits" } satisfies Stage,
   ```
2. Create `packages/core/templates/lint.md` using the same `` !`cmd` `` + `{{ INPUTS }}` syntax.
3. Wire it into the chain in `main.ts` / `gh-main.ts`:
   ```ts
   stages: [STAGES.implementer, STAGES.linter, STAGES.reviewer],
   ```
4. `pnpm -r build` and republish.

Only the first stage is the gate (sentinel-checked). Subsequent stages always run after a non-sentinel gate result.

### Change the template syntax

Renderer is in `packages/core/src/render.ts`. Tags supported today:

- `` !`<shell cmd>` `` — executed via `bash -c` (Linux/WSL) or `cmd.exe` (Windows) with `cwd = workspaceDir`. stdout (trailing newline trimmed) replaces the tag.
- `{{ INPUTS }}` — replaced with the `inputs` field passed into `runLoop`.

Failures in `` !`…` `` throw and abort the iteration. Use shell-level `|| echo "<fallback>"` in the template if a command is allowed to fail.

### Override the image

Set `RALPH_IMAGE=registry.example.com/my-image:tag` before invoking the shim, or edit the default in `packages/core/src/runner.ts`. The runner does `inspect` → `pull` → `build` against whatever ref is set; legacy `RALPH_IMAGE_TAG` still works for backward compatibility.

### Change feedback loops or task priority

Edit `packages/core/templates/prompt.md` (and `ghprompt.md`) — the playbooks injected via `@include:prompt.md`.

---

## Stopping a run

- **Natural stop:** implementer emits `<promise>NO MORE TASKS</promise>`.
- **Manual stop:** `Ctrl+C`. `set -eo pipefail` in the shim and `exec npx …` propagate the signal cleanly. Tempfiles under `.ralph-tmp/.run-*.md` are removed by the `finally` block in `runner.ts`; SIGKILL may leave them — safe to delete, gitignored.

---

## Troubleshooting

- **`Cannot find module '@daonhan/ralph-core'`** — `@daonhan/ralph` was installed but its dep didn't resolve. Re-run `npm install` (or `pnpm install`) in the workspace, or use `npx -y @daonhan/ralph` to let npx fetch a clean copy.
- **`@esbuild/win32-x64 package is present but this platform needs @esbuild/linux-x64`** — `node_modules/` installed from the wrong OS. Delete `node_modules/` + lockfile and reinstall under WSL.
- **`Not logged in · Please run /login`** — Claude credentials missing inside the container. Run the interactive `docker run … claude /login` step from "First-run setup".
- **`gh issue list` fails with `not a git repository`** — the workspace has no `.git`. The `ghafk.md` template uses `|| echo "[]"` fallback so the iteration still proceeds, but `gh` cannot detect the target repo. Initialize the repo, or push first.
- **`MSB3248` during `dotnet build` / `dotnet test`** — virtiofs/9p quirk on Windows-mounted source. The agent retries automatically per the recipe in `packages/core/templates/prompt.md`; manual repro:
  ```bash
  dotnet test <path-to-test-csproj> \
    -m:1 \
    /p:UseSharedCompilation=false \
    /p:BuildInParallel=false \
    /p:BaseIntermediateOutputPath=/tmp/ralph-obj/<name>/ \
    /p:BaseOutputPath=/tmp/ralph-bin/<name>/
  ```
- **`docker run` exit 1 with no claude output** — image stale. Force refresh:
  ```bash
  docker rmi docker.io/daonhan/ralph-sandbox:latest
  docker pull docker.io/daonhan/ralph-sandbox:latest
  ```
- **`docker pull failed … and no Dockerfile at …`** — the default image ref isn't reachable (offline, registry down, or you set a custom `$RALPH_IMAGE` that doesn't exist) AND no Dockerfile is at `$RALPH_DOCKER_CONTEXT`. Fix one of: connectivity, `RALPH_IMAGE`, or place a Dockerfile at `$RALPH_DOCKER_CONTEXT`.
- **`pull access denied … repository does not exist`** — `$RALPH_IMAGE` points at a private repo or a typo. Either `docker login`, switch to a public image, or unset `RALPH_IMAGE` to use the default.

---

## Files in this folder

| File / dir | Purpose |
| --- | --- |
| [`apps/cli/scripts/afk.sh`](./apps/cli/scripts/afk.sh) | Optional shim — plan/PRD loop. Falls back to `npx @daonhan/ralph ralph-afk`. Shipped in the npm tarball. |
| [`apps/cli/scripts/ghafk.sh`](./apps/cli/scripts/ghafk.sh) | Optional shim — GitHub-issue loop. Calls `ralph-ghafk`. |
| [`packages/core/templates/prompt.md`](./packages/core/templates/prompt.md) | Agent playbook for `ralph-afk`. Shipped in core tarball. |
| [`packages/core/templates/ghprompt.md`](./packages/core/templates/ghprompt.md) | Agent playbook for `ralph-ghafk`. Shipped in core tarball. |
| [`packages/core/Dockerfile`](./packages/core/Dockerfile) | Builds `ralph-sandbox` image: Node 22 + .NET SDK 9 + `gh` + `claude`. Shipped in `@daonhan/ralph-core` tarball. |
| [`.dockerignore`](./.dockerignore) | Shrinks build context (consumed at repo root for CI builds). |
| [`package.json`](./package.json) | Monorepo root (private). Shared devDeps + pnpm workspace scripts. |
| [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) | Declares `apps/*` and `packages/*` as workspace members. |
| [`tsconfig.base.json`](./tsconfig.base.json) | Shared TS compiler options inherited by every package. |
| [`apps/cli/`](./apps/cli) | `@daonhan/ralph` — CLI bin entries (`ralph-afk`, `ralph-ghafk`). |
| [`packages/core/src/main.ts`](./packages/core/src/main.ts) | Exports `runAfk(argv)`. |
| [`packages/core/src/gh-main.ts`](./packages/core/src/gh-main.ts) | Exports `runGhAfk(argv)`. |
| [`packages/core/src/loop.ts`](./packages/core/src/loop.ts) | Iteration driver. Runs stage chain; first stage is the gate. |
| [`packages/core/src/render.ts`](./packages/core/src/render.ts) | Template renderer (`` !`cmd` `` + `{{ INPUTS }}`). |
| [`packages/core/src/runner.ts`](./packages/core/src/runner.ts) | `docker run` wrapper + NDJSON stream + credential mounts. Image lookup: inspect → pull → build. Reads `RALPH_IMAGE`. |
| [`.github/workflows/publish-image.yml`](./.github/workflows/publish-image.yml) | CI: build + push multi-arch `ralph-sandbox` to Docker Hub on `workflow_dispatch` or `image-v*` tag. |
| [`packages/core/src/stages.ts`](./packages/core/src/stages.ts) | Stage registry — `implementer`, `ghafkImplementer`, `reviewer`. |
| [`packages/core/src/index.ts`](./packages/core/src/index.ts) | Barrel re-export — `runAfk`, `runGhAfk`, `runLoop`, `STAGES`, `renderTemplate`, … |
| [`packages/core/templates/afk.md`](./packages/core/templates/afk.md) | `ralph-afk` prompt template. |
| [`packages/core/templates/ghafk.md`](./packages/core/templates/ghafk.md) | `ralph-ghafk` prompt template. |
| [`packages/core/templates/review.md`](./packages/core/templates/review.md) | Reviewer prompt template. |
