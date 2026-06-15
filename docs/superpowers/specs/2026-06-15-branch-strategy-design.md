# Design: configurable branch strategy for the AFK bins

Date: 2026-06-15
Status: Approved (brainstorm), pending spec review → implementation plan
Applies to: both `ralph-afk` and `ralph-ghafk`.

## Problem

Ralph commits straight onto whatever branch is checked out in the target workspace
(`runner.ts` spawns `claude` with `cwd = workspaceDir` on the current `HEAD`; the
playbooks `prompt.md` / `ghprompt-workflow.md` instruct `git commit -am` with no
branch creation). Over N iterations every implementer + reviewer/panel commit lands
on the current branch.

Observed live on a real run (`feat/firebase-migration` in another repo): Ralph's
autonomous commits (`feat(analytics)…`, `fix(review)…`) interleave with the
operator's own manual commits on the same active feature branch — no clean way to
review, revert, or PR Ralph's work as a unit. The same investigation surfaced two
adjacent gaps (B and C below).

## Scope

Three items, one spec:

- **A. Branch strategy** — choose `current` | `branch` | `worktree` once per run at
  startup, resolved by a precedence ladder (flag/env → learned config → prompt →
  safe default).
- **B. `.gitignore` hygiene** — ensure `.ralph-tmp/` is ignored in the workspace
  (it currently isn't auto-managed; ARCHITECTURE.md assumes it is).
- **C. Dirty-tree warning** — warn loudly at startup when the worktree has
  uncommitted tracked changes, because that silently disables the review panel's
  read-only `reset --hard` enforcement (`panel.ts`).

**Out of scope (locked):** no auto-push, no auto-PR, no auto-merge. Ralph stops at
"the work is on the branch/worktree"; integration is the operator's job. Strategy is
resolved **once per run**, not per task/issue.

---

## A. Branch strategy

### Surface

- Flag `--branch <current|branch|worktree>` / env `RALPH_BRANCH`.
- Flag `--branch-prefix <p>` / env `RALPH_BRANCH_PREFIX` (default `ralph/`).
- Both echoed by `--print-config`.
- New workspace file **`.ralph/config.json`** (git-tracked, alongside `LEARNINGS.md`):

  ```json
  { "branchStrategy": "worktree", "branchPrefix": "ralph/" }
  ```

  Machine-readable, deliberately separate from the prose `LEARNINGS.md`. Only the two
  keys above; unknown keys ignored; absent file is fine.

### Resolution — precedence ladder

A new module `packages/core/src/branch.ts` exports:

```ts
export type BranchStrategy = "current" | "branch" | "worktree";

export type ResolvedBranch = {
  strategy: BranchStrategy;
  branchName: string | null; // null for "current"
  effectiveWorkspaceDir: string; // = workspaceDir except in worktree mode
  summaryLine: string; // printed once at startup
};

export async function resolveBranch(opts: {
  workspaceDir: string;
  inputs: string; // afk: "<plan> <prd>" paths; ghafk: ""
  flagStrategy?: BranchStrategy; // --branch
  flagPrefix?: string; // --branch-prefix
  isTTY: boolean;
}): Promise<ResolvedBranch>;
```

Strategy is resolved in order; first hit wins:

1. `--branch` / `RALPH_BRANCH` (explicit; invalid value → error + exit).
2. `.ralph/config.json` `branchStrategy` (learned default).
3. **Prompt** — only if `isTTY`. Ask strategy `[current/branch/worktree]`, then
   `Remember for this repo? [y/N]`; on yes, write/merge `.ralph/config.json`
   (strategy + resolved prefix).
4. Fallback `current` (so `--detach` / non-TTY / no-config runs never block).

Prefix resolves independently by the same flag→env→config→default(`ralph/`) chain.

### Branch naming

`branchName = <prefix> + <slug>`, where `slug` is:

- **afk:** slugify the basename (sans extension) of the first token of `inputs`
  (the plan file). e.g. `docs/2026-…-analytics.md` → `ralph/analytics`.
- **ghafk:** no issue is chosen until iteration 1, so there is no startup slug →
  fall back to a timestamp slug: `<prefix>YYYYMMDD-HHMM`.
- slugify: lowercase, non-alphanumerics → `-`, collapse repeats, trim, cap length.
- **Collision:** if the target ref (or worktree path) already exists, append
  `-2`, `-3`, … until free.

Timestamp is taken in `apps/cli`/core Node runtime (real `Date`), not a workflow
sandbox — no constraint.

### The three strategies

- **`current`** — no git side-effect. `effectiveWorkspaceDir = workspaceDir`.
  Byte-for-byte today's behaviour.
- **`branch`** — `git switch -c <branchName>` in `workspaceDir`, cut from current
  `HEAD` (carries any uncommitted changes onto the new branch, standard git).
  `effectiveWorkspaceDir = workspaceDir`.
- **`worktree`** — `git worktree add -b <branchName> <path> HEAD`, where
  `path = <workspaceDir>/.ralph-tmp/worktrees/<slug>`. `effectiveWorkspaceDir =
path`. The entire run (impl + reviewer/panel + `LEARNINGS.md` commits) happens in
  the worktree on its own branch. The worktree is its own checkout (separate
  `.git` file), so the parent's gitignore of `.ralph-tmp/` (item B) does not affect
  it, and the parent working tree shows none of the worktree's churn.

  **Not auto-removed** — it holds the work. At end-of-run print the path + a
  `git worktree remove <path>` hint. The per-iteration cleanup in `runner.ts`
  (`.run-*.md`, `spill-*/`) must continue to target only those globs and **never**
  recurse into `worktrees/`.

### Edge cases / errors

- **Not a git repo:** `branch`/`worktree` → clear error + non-zero exit; `current`
  still works (and is the default, so non-git workspaces are unaffected unless the
  operator explicitly asks for isolation).
- **Dirty tree + `worktree`:** the worktree is cut from `HEAD`; uncommitted tracked
  changes stay in the main checkout and are **not** carried in. Print a one-line
  notice that they were left behind. (See also item C.)
- **`branch` already current:** if the resolved branch equals the current branch,
  no-op with a note.

### Integration point (`run-bin.ts`)

`workspaceDir` is resolved once near the top. The detach fork (`detachAndExit`)
re-execs the bin with the same argv, so branch resolution **must run after** that
fork (otherwise the git side-effect would happen twice — once in parent, once in
child). Therefore:

- Place `resolveBranch(...)` **after** the `if (flags.detach) detachAndExit()`
  block and **before** the `runWatch` / `runLoop` dispatch.
- A detached child has `process.stdout.isTTY === false` → no prompt → it relies on
  flag/config/default. Pass `isTTY = Boolean(process.stdout.isTTY)`.
- Replace the `workspaceDir` passed into `runWatch({ … })` and `runLoop({ … })`
  with `resolved.effectiveWorkspaceDir`. `packageDir` is unchanged. Everything
  downstream (runner cwd, render shell cwd, reviewer, panel, spill, `.ralph-tmp`,
  `.ralph/LEARNINGS.md`) inherits the effective dir with no further change.
- Print `resolved.summaryLine` once before the loop.
- For `--watch` (ghafk daemon): `resolveBranch` runs once at daemon start; the whole
  daemon lifetime uses the one effective dir/branch. (Acceptable; matches the
  "once per run" decision.)

---

## B. `.gitignore` hygiene

`.ralph-tmp/` is **not** auto-ignored. Today harmless (playbooks use `git commit -am`
= tracked files only), but any `git add -A` would commit rendered prompts + NDJSON
logs. ARCHITECTURE.md already calls `.ralph-tmp/` "gitignored" — make it true.

On startup (in `run-bin.ts`, once, before the loop; cheap and idempotent): if the
workspace is a git repo and `.ralph-tmp/` is not already ignored, append a
`.ralph-tmp/` line to the workspace `.gitignore` (create the file if absent). Do
**not** ignore `.ralph/` — `LEARNINGS.md` (and now `config.json`) are durable,
git-tracked memory. Idempotent: skip if `git check-ignore .ralph-tmp` already
succeeds.

Small helper, e.g. `ensureRalphTmpIgnored(workspaceDir)`, callable from `branch.ts`
or a tiny `gitignore.ts`. Reuse whichever fits; keep the bin layer flat.

---

## C. Dirty-tree warning

`panel.ts` disables its read-only `reset --hard` enforcement when the worktree has
uncommitted **tracked** changes ("won't risk your changes"), silently weakening the
panel. Surface this:

At startup, if `strategy !== "worktree"` (worktree starts clean by construction) and
the workspace has uncommitted tracked changes, print a clear warning — e.g.
`⚠ working tree has uncommitted changes — review-panel read-only enforcement will be
disabled; consider committing/stashing or using --branch worktree`. Warning only; do
not block (AFK must not require interaction). Reuse the existing tracked-dirtiness
check from `panel.ts` (extract/share rather than duplicate the git invocation).

---

## Testing

`packages/core/src/__tests__/branch.test.ts` (vitest):

- Precedence ladder: flag > config > (non-TTY ⇒ skip prompt ⇒ default) > `current`.
- Invalid `--branch` value → error.
- slugify: extension stripping, non-alnum, length cap; ghafk empty-inputs →
  timestamp slug.
- Collision suffixing (`-2`, `-3`).
- `config.json` read (present/absent/garbage) and the "remember" write/merge.
- Strategy mechanics against a tmp git repo: `branch` creates + switches;
  `worktree` adds at `.ralph-tmp/worktrees/<slug>` and returns it as
  `effectiveWorkspaceDir`; `current` is a no-op.
- Not-a-git-repo → `branch`/`worktree` error; `current` ok.
- `ensureRalphTmpIgnored`: appends once, idempotent on re-run, creates `.gitignore`
  when absent, leaves `.ralph/` tracked.
- Dirty-tree detection drives the warning (worktree mode suppresses it).

Prompting is isolated behind the `isTTY` branch, so all of the above run without a
terminal. `pnpm -r typecheck && pnpm -r test && pnpm test` stays green.

## File-change summary

- **New:** `packages/core/src/branch.ts` (+ optional `gitignore.ts`),
  `packages/core/src/__tests__/branch.test.ts`.
- **Edit:** `cli-help.ts` (flags + `--print-config`), `run-bin.ts` (wire in after
  detach fork; pass `effectiveWorkspaceDir`; gitignore + dirty warning calls).
- **Docs:** README env/flags table, `docs/ARCHITECTURE.md`.
- **Untouched:** templates, stages, loop spine, runner internals (they just receive
  a different `workspaceDir`).
