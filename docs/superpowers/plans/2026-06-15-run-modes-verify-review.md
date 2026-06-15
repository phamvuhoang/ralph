# Verify & Apply-Review Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two `ralph-afk` run modes — `--verify` (read-only: reconcile a plan against git + run suites + report, no commits) and `--apply-review <doc>` (fix the actionable findings of a code-review document, track follow-ups, skip cosmetics).

**Architecture:** Each mode is a new playbook template + a new `STAGES` entry, selected by a flag that swaps the gate stage chain in `run-bin.ts` — generalizing the existing `--issue`/`issueStage` mechanism. No changes to `loop.ts` / `render.ts` / `runner.ts`; both modes inherit resilience + the reconcile-against-git rule from the loop.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import suffixes), vitest. Templates are markdown with `{{ INPUTS }}` / `{{ RESUME }}` tags + `@include` / `!?` shell tags.

Spec: `docs/superpowers/specs/2026-06-15-run-modes-verify-review-design.md`.

**Dependency:** Built on `feat/resilient-loops` (PR #29): the `RESUME` template var, `state.json` `mode` field, and the B1 reconcile rule already exist on this branch. **Conventions:** ESM-only, `.js` imports; `pnpm -r build` before any bin smoke; Verify = `pnpm -r typecheck && pnpm -r test && pnpm test`; pre-commit runs prettier + typecheck.

---

## File Structure

- **New** `packages/core/templates/verify.md` — read-only verify playbook (Part A).
- **New** `packages/core/templates/apply-review.md` — review-triage playbook (Part B).
- **Modify** `packages/core/src/stages.ts` — add `verifier` + `applyReviewImplementer` to `STAGES`.
- **Modify** `packages/core/src/run-bin.ts` — add `verifyStage`/`applyReviewStage` to `RunBinConfig`; resolve the mode; swap the stage chain; arg handling; pass `mode` to `runLoop`; mutual-exclusion guards.
- **Modify** `packages/core/src/main.ts` — wire `verifyStage` + `applyReviewStage` onto the afk config.
- **Modify** `packages/core/src/cli-help.ts` — `--verify` / `--apply-review <doc>` flags, help, `--print-config`.
- **Modify** `packages/core/src/__tests__/cli-help.test.ts` — flag parsing tests.
- **Modify** `README.md`, `docs/ARCHITECTURE.md` — document the two modes.

`ghafk` gets neither mode (afk-only this round): `cfg.verifyStage`/`applyReviewStage` are undefined for `ralph-ghafk`, so the run-bin guards reject `--verify`/`--apply-review` there.

---

## Task 1: New playbook templates + render smoke

**Files:**

- Create: `packages/core/templates/verify.md`
- Create: `packages/core/templates/apply-review.md`

No unit test (templates are content); verified by a render smoke + `superpowers-include.test.ts` staying green.

- [ ] **Step 1: Create `packages/core/templates/verify.md`**

```markdown
{{ RESUME }}

<commits>

!?`git log -n 15 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<inputs>

{{ INPUTS }}

</inputs>

# VERIFY (READ-ONLY)

You are VERIFYING, not implementing. The `<inputs>` block names a plan and PRD (conventionally file paths). `Read` them.

**Make NO commits and NO source edits.** You may read files and run the test/type suites. The only file you may write is the report named at the end.

# RECONCILE

For each task in the plan, determine its true status from reality, not from checkboxes:

- Inspect recent `git log` (above) and the working tree. Code that is present and committed is **done** — even if the plan's checkbox is unticked. Treat checkboxes as hints, not truth.
- Cite evidence: the `file:line` or commit SHA that implements the task.

# RUN THE SUITES

Run the project's test and type checks read-only to confirm the implemented work is green. Use the repo's conventional commands (e.g. `pnpm -r test` / `pnpm -r typecheck`; `dotnet test` / `dotnet build`). Record pass/fail counts.

# CLASSIFY

Put every task in exactly one bucket:

- **DONE** — implemented, committed, evidence cited, suites green.
- **GAP** — not implemented, incomplete, or failing. Say what is missing.
- **DEFERRED** — intentionally not done in this environment (operational / needs prod creds / AFK-deferred). Say why.

# REPORT

Write your report to `.ralph-tmp/verify-report.md` using the `Write` tool (this path is gitignored scratch — it is the one write you may make). Structure it:
```

# Verify report

## Verdict

<one-line: all done / N gaps / N deferred>

## Done

- <task> — <evidence: file:line or commit>

## Gaps

- <task> — <what is missing>

## Deferred

- <task> — <why>

## Suites

- <command> — <pass/fail counts>

```

Also print the Verdict + section counts to your final message. Do not commit.
```

- [ ] **Step 2: Create `packages/core/templates/apply-review.md`**

```markdown
{{ RESUME }}

<commits>

!?`git log -n 15 --format="%H%n%ad%n%B---" --date=short|||No commits found`

</commits>

<learnings>

!?`cat ./.ralph/LEARNINGS.md|||_No learnings recorded yet._`

</learnings>

<existing-followups>

!?`cat ./.ralph/review-followups.md|||_No follow-ups recorded yet._`

</existing-followups>

<review-doc>

{{ INPUTS }}

</review-doc>

# APPLY REVIEW

`<review-doc>` names a code-review document (a file path). `Read` it. It contains findings, usually with severities. Your job is to fix the actionable ones — ONE finding per iteration — and track the rest.

When every actionable finding has been addressed (fixed, or already fixed in git, or recorded as a follow-up), output `<promise>NO MORE TASKS</promise>`.

# TRIAGE

Classify each finding (judge from the review's own language — severity labels, "follow-up", "operational", "cosmetic", "low risk"):

- **Actionable** — a safe, in-scope correctness fix or cleanup (e.g. dead code, a clear bug, an incomplete cleanup). Fix it.
- **Deferred / follow-up** — perf optimisation, operational steps, or anything large/out-of-scope (e.g. "re-reads N days every pull", "backfill mandatory at deploy"). Do NOT implement now; record it (below).
- **Low / cosmetic / won't-fix** — note it in your commit body / final message with the reason; take no action.

# RECONCILE BEFORE FIXING

Before fixing a finding, check recent `git log` and the working tree — if it is already fixed, skip it (don't redo committed work). Treat the review as possibly stale.

# FIX ONE FINDING

Pick the highest-value actionable finding not yet addressed. Implement the fix. Run the feedback loops:

### Frontend / Node

- `pnpm run test`, `pnpm run typecheck`

### Backend / Dotnet

- `dotnet test`, `dotnet build`

# RECORD FOLLOW-UPS

For each Deferred / follow-up finding, append a terse entry to `./.ralph/review-followups.md` (create it lazily). Use a dated `##` heading for this review, then one bullet per finding with its severity and why it is deferred. This file is git-tracked — commit it WITH the related fix (do not make a separate commit just for it).

# COMMIT

Make a single `git commit -am` with a short message:

- Subject (≤72 chars): `fix(review): <what changed>`
- Body: which finding (and its review section), key decision, and a one-line note of any follow-ups recorded.
- No file lists, no `Co-Authored-By`.

# FINAL RULES

ONLY ADDRESS A SINGLE FINDING per iteration.
```

- [ ] **Step 3: Render smoke**

```bash
pnpm -r build >/dev/null
node --input-type=module -e "
import { renderTemplate } from './packages/core/dist/render.js';
for (const t of ['verify.md','apply-review.md']) {
  const p = 'packages/core/templates/' + t;
  const o = renderTemplate(p, { INPUTS: 'plan.md prd.md', RESUME: '' }, { cwd: process.cwd(), spillHostDir: '/tmp/x', spillRefPath: '.ralph-tmp/x' });
  console.log(t, 'INPUTS ok:', o.includes('plan.md prd.md'), '| no leaked tag:', !o.includes('{{'));
}
"
```

Expected: both lines show `INPUTS ok: true | no leaked tag: true`.

- [ ] **Step 4: Verify the suite is unaffected + commit**

```bash
pnpm --filter @phamvuhoang/ralph-core test -- superpowers-include && pnpm -r test
git add packages/core/templates/verify.md packages/core/templates/apply-review.md
git commit -m "feat(core): verify + apply-review playbook templates"
```

---

## Task 2: STAGES entries + RunBinConfig fields + main.ts wiring

**Files:**

- Modify: `packages/core/src/stages.ts`
- Modify: `packages/core/src/run-bin.ts` (the `RunBinConfig` type only — wiring of logic is Task 4)
- Modify: `packages/core/src/main.ts`

- [ ] **Step 1: Add stages to `STAGES`** in `stages.ts`, after `ghafkIssueImplementer`:

```ts
  verifier: {
    name: "verifier",
    template: "verify.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  applyReviewImplementer: {
    name: "apply-review-implementer",
    template: "apply-review.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
```

- [ ] **Step 2: Add config fields** to `RunBinConfig` in `run-bin.ts`, beside `issueStage`:

```ts
  /** Single read-only gate stage used when --verify is set. Only ralph-afk sets this. */
  verifyStage?: Stage;
  /** Gate stage used when --apply-review is set. Only ralph-afk sets this. */
  applyReviewStage?: Stage;
```

- [ ] **Step 3: Wire them in `main.ts`** (the `runAfk` config object):

```ts
    issueStage: undefined,
    verifyStage: STAGES.verifier,
    applyReviewStage: STAGES.applyReviewImplementer,
```

(Add the two lines; `ralph-afk` has no `issueStage` — only add `verifyStage`/`applyReviewStage`. Do NOT touch `gh-main.ts`; ghafk gets neither mode.)

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm -r typecheck
git add packages/core/src/stages.ts packages/core/src/run-bin.ts packages/core/src/main.ts
git commit -m "feat(core): register verifier + apply-review stages, wire onto afk config"
```

Expected: typecheck clean (the new `RunBinConfig` fields are optional; run-bin logic comes in Task 4).

---

## Task 3: CLI flags `--verify` / `--apply-review`

**Files:**

- Modify: `packages/core/src/cli-help.ts`
- Modify: `packages/core/src/__tests__/cli-help.test.ts`

- [ ] **Step 1: Add failing tests** — append to `cli-help.test.ts`:

```ts
describe("parseFlags --verify / --apply-review", () => {
  it("parses --verify (boolean)", () => {
    const f = parseFlags(["--verify", "plan.md prd.md"]);
    expect(f.verify).toBe(true);
    expect(f.rest).toEqual(["plan.md prd.md"]);
  });
  it("parses --apply-review <doc>", () => {
    const f = parseFlags(["--apply-review", "review.md", "10"]);
    expect(f.applyReview).toBe("review.md");
    expect(f.rest).toEqual(["10"]);
  });
  it("errors when --apply-review has no value", () => {
    expect(() => parseFlags(["--apply-review"])).toThrow(
      /--apply-review requires a value/
    );
  });
  it("defaults verify false and applyReview undefined", () => {
    const f = parseFlags(["5"]);
    expect(f.verify).toBe(false);
    expect(f.applyReview).toBeUndefined();
  });
});
```

Run `pnpm --filter @phamvuhoang/ralph-core test -- cli-help.test` → FAIL.

- [ ] **Step 2: Implement in `cli-help.ts`.** Add to `CliFlags`:

```ts
  verify: boolean;
  applyReview?: string;
```

In `parseFlags`, add locals: `let verify = false; let applyReview: string | undefined; let expectingApplyReview = false;`. Consume-value block (with the other `if (expecting...)` blocks):

```ts
if (expectingApplyReview) {
  applyReview = a;
  expectingApplyReview = false;
  continue;
}
```

Flag-name chain: `else if (a === "--verify") verify = true;` and `else if (a === "--apply-review") expectingApplyReview = true;`. Post-loop guard:

```ts
if (expectingApplyReview) {
  throw new Error("--apply-review requires a value");
}
```

Add `verify,` and `applyReview,` to the returned object.

- [ ] **Step 3: Help + print-config.** In `printHelp` Flags block add:

```
  --verify            read-only: reconcile the plan against git, run the suites, write a report; make no commits (ralph-afk)
  --apply-review <doc>  fix the actionable findings of a code-review document; track follow-ups (ralph-afk)
```

In `PrintConfigOptions` add `mode?: string;` and in `printConfig` add a line after `version` (or near `issue`):

```ts
  mode                  ${mode ?? "afk"}
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

```bash
pnpm --filter @phamvuhoang/ralph-core test -- cli-help.test && pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cli-help.ts packages/core/src/__tests__/cli-help.test.ts
git commit -m "feat(core): add --verify / --apply-review flags"
```

---

## Task 4: run-bin mode resolution + stage swap + arg handling

**Files:**

- Modify: `packages/core/src/run-bin.ts`

This is the integration task. The current flow (post-merge) computes `inputs`, `iterationsArg`, validates, then `stages = flags.issue != null ? [issueStage, ...] : cfg.stages`, then calls `runLoop({ ..., mode: cfg.mode, ... })`. Extend it for the two new modes.

- [ ] **Step 1: Mutual-exclusion + capability guards.** Right after the existing `if (flags.issue != null && !cfg.issueStage) { ... }` guard, add:

```ts
const modeCount =
  (flags.issue != null ? 1 : 0) +
  (flags.verify ? 1 : 0) +
  (flags.applyReview != null ? 1 : 0) +
  (flags.watch ? 1 : 0);
if (modeCount > 1) {
  console.error(
    "--issue, --verify, --apply-review, and --watch are mutually exclusive"
  );
  process.exit(1);
}
if (flags.verify && !cfg.verifyStage) {
  console.error("--verify is only supported by ralph-afk");
  process.exit(1);
}
if (flags.applyReview != null && !cfg.applyReviewStage) {
  console.error("--apply-review is only supported by ralph-afk");
  process.exit(1);
}
```

- [ ] **Step 2: Resolve inputs + iterations for the new modes.** Replace the existing `inputs` and `iterationsArg` declarations with:

```ts
const inputs =
  flags.issue != null
    ? String(flags.issue)
    : flags.applyReview != null
      ? flags.applyReview
      : cfg.takesInputArg
        ? flags.rest[0]
        : "";
// --verify is one-shot (iterations forced to 1 below); --apply-review takes the
// doc as its flag value, so the iterations count is the first remaining positional.
const iterationsArg =
  flags.applyReview != null
    ? flags.rest[0]
    : cfg.takesInputArg
      ? flags.rest[1]
      : flags.rest[0];
```

- [ ] **Step 3: Validation + iterations for verify.** Replace the existing usage/iterations validation block:

```ts
if ((cfg.takesInputArg && !inputs) || !iterationsArg) {
  console.error(`Usage: ${cfg.bin} ${cfg.usage}`);
  console.error(`       ${cfg.bin} --help`);
  process.exit(1);
}
const iterations = Number.parseInt(iterationsArg, 10);
if (!Number.isFinite(iterations) || iterations < 1) {
  console.error(`Invalid iterations: ${iterationsArg}`);
  process.exit(1);
}
```

with a verify-aware version:

```ts
if (flags.verify && (!cfg.takesInputArg || !inputs)) {
  console.error(`Usage: ${cfg.bin} --verify "<plan-and-prd>"`);
  process.exit(1);
}
if (!flags.verify && ((cfg.takesInputArg && !inputs) || !iterationsArg)) {
  console.error(`Usage: ${cfg.bin} ${cfg.usage}`);
  console.error(`       ${cfg.bin} --help`);
  process.exit(1);
}
// --verify is one-shot regardless of any positional count.
const iterations = flags.verify ? 1 : Number.parseInt(iterationsArg, 10);
if (!flags.verify && (!Number.isFinite(iterations) || iterations < 1)) {
  console.error(`Invalid iterations: ${iterationsArg}`);
  process.exit(1);
}
```

- [ ] **Step 4: Stage chain swap.** Replace the existing `const stages = flags.issue != null ? (...) : cfg.stages;` with:

```ts
const stages: [Stage, ...Stage[]] = flags.verify
  ? [cfg.verifyStage!]
  : flags.applyReview != null
    ? [cfg.applyReviewStage!, ...cfg.stages.slice(1)]
    : flags.issue != null
      ? [cfg.issueStage!, ...cfg.stages.slice(1)]
      : cfg.stages;
```

- [ ] **Step 5: Mode string for runLoop + print-config.** Add near the top (after the guards):

```ts
const runMode = flags.verify
  ? "verify"
  : flags.applyReview != null
    ? "review"
    : cfg.mode;
```

In the `printConfig(...)` options object add `mode: runMode,`. In the `runLoop({ ... })` call, change `mode: cfg.mode,` to `mode: runMode,`.

- [ ] **Step 6: Guard `--issue`-only env set.** The existing `if (flags.issue != null) { ... process.env.RALPH_ISSUE = ... }` block is unchanged and only runs for issue mode. Leave it.

- [ ] **Step 7: Build + full verify + smokes**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm test
SMOKE=$(mktemp -d) && (cd "$SMOKE" && git init -q && git commit -q --allow-empty -m init)
# verify mode: no iterations arg required, mode=verify
RALPH_WORKSPACE=$SMOKE node apps/cli/bin/ralph-afk.js --verify --print-config "plan.md prd.md" 2>&1 | grep -iE "mode"
# apply-review: doc is the flag value, mode=review
RALPH_WORKSPACE=$SMOKE node apps/cli/bin/ralph-afk.js --apply-review review.md --print-config 10 2>&1 | grep -iE "mode"
# mutual exclusion
RALPH_WORKSPACE=$SMOKE node apps/cli/bin/ralph-afk.js --verify --apply-review review.md 1 2>&1 | tail -1
# ghafk rejects --verify
RALPH_WORKSPACE=$SMOKE node apps/cli/bin/ralph-ghafk.js --verify 1 2>&1 | tail -1
```

Expected: first → `mode  verify`; second → `mode  review`; third → mutually-exclusive error; fourth → "--verify is only supported by ralph-afk".

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/run-bin.ts
git commit -m "feat(core): wire --verify / --apply-review modes into run-bin"
```

---

## Task 5: Documentation

**Files:**

- Modify: `README.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: README** — add `--verify` and `--apply-review <doc>` to the flags table; a short "Verify & apply-review modes" subsection: `--verify` reconciles the plan against git + runs suites + writes a read-only report to `.ralph-tmp/verify-report.md` (no commits, one pass); `--apply-review <doc>` fixes actionable review findings one per iteration, records deferred ones in `.ralph/review-followups.md`, skips cosmetics; note both are `ralph-afk`-only and distinct from `--review-panel`.

- [ ] **Step 2: ARCHITECTURE.md** — in the loop-topology section add the two new chains:

```
ralph-afk --verify        → [verifier]                          inputs = "<plan-and-prd>" (one pass, read-only)
ralph-afk --apply-review D → [applyReviewImplementer, reviewer]  inputs = D (review doc)
```

and note `verify.md` / `apply-review.md` in the templates orientation + the `.ralph/review-followups.md` git-tracked file.

- [ ] **Step 3: Verify + commit**

```bash
pnpm -r typecheck && pnpm -r test && pnpm test
git add README.md docs/ARCHITECTURE.md
git commit -m "docs: document --verify and --apply-review modes"
```

---

## Self-Review Notes (resolved)

- **Spec coverage:** shared gate-swap → Task 4 Step 4; Part A (verify) → templates T1, stage T2, flag T3, wiring + iterations=1 T4; Part B (apply-review) → template T1, stage T2, flag T3, wiring T4, follow-ups file in `apply-review.md` (T1); mutual exclusion → T4 Step 1; arg handling (doc=flag value, iters=rest[0]) → T4 Step 2; docs → T5.
- **Type consistency:** `STAGES.verifier` / `STAGES.applyReviewImplementer` (T2) referenced by `cfg.verifyStage` / `cfg.applyReviewStage` (T2 type, T3 main wiring, T4 usage). `flags.verify` (bool) / `flags.applyReview` (string?) defined T3, used T4. `runMode` string `"verify"|"review"|cfg.mode` passed to `runLoop`'s existing `mode` option (from PR #29).
- **`Stage` import in run-bin:** the `stages` annotation uses `Stage` — already imported in `run-bin.ts` (`import type { Stage }`).
- **No loop/runner/render change:** confirmed; modes ride the existing render→runStage path and the resilience layer.
- **Verify report path:** templates use a fixed `.ralph-tmp/verify-report.md` (gitignored) rather than a timestamped name, to keep the agent's `Write` target static and the smoke deterministic; the spec's `<timestamp>` was illustrative. If concurrent verify runs ever matter, revisit — out of scope now.
