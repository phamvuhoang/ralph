import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dirtyTreeWarning,
  ensureRalphTmpIgnored,
  resolveBranch,
} from "./branch.js";
import {
  parseFlags,
  parseDurationMs,
  printConfig,
  printHelp,
  printVersion,
} from "./cli-help.js";
import { detachAndExit } from "./detach.js";
import { runLoop } from "./loop.js";
import type { Stage } from "./stages.js";

export type RunBinConfig = {
  /** Bin name for usage/version/config output (e.g. "ralph-afk"). */
  bin: string;
  /** Positional-arg usage string (e.g. "<plan-and-prd> <iterations>"). */
  usage: string;
  /** One-line description for --help. */
  desc: string;
  /** Stage chain; first stage is the gate. */
  stages: [Stage, ...Stage[]];
  /**
   * Whether the bin takes a leading input positional before <iterations>.
   * `true`  → argv is `<inputs> <iterations>` (ralph-afk; inputs = rest[0]).
   * `false` → argv is `<iterations>`          (ralph-ghafk; inputs = "").
   */
  takesInputArg: boolean;
  cliVersion?: string;
  /** Whether this bin supports --watch. Only ralph-ghafk sets this. */
  supportsWatch?: boolean;
  /** Alternate gate stage used when --issue is set. Only ralph-ghafk sets this. */
  issueStage?: Stage;
  /** Run mode identifier threaded into runLoop state (e.g. "afk" / "ghafk"). */
  mode: string;
};

/**
 * Ensure .ralph/state.json is listed in the workspace .gitignore.
 * No-op when the workspace has no .git directory (not a git repo).
 * Kept separate from branch.ts's ensureRalphTmpIgnored: that targets the parent
 * workspaceDir (.ralph-tmp/), while state.json lives in the effective workspace
 * (the worktree, in worktree mode) where the loop writes it.
 */
function ensureStateGitignored(workspaceDir: string): void {
  if (!existsSync(join(workspaceDir, ".git"))) return;
  const gitignorePath = join(workspaceDir, ".gitignore");
  const entry = ".ralph/state.json";
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  const alreadyPresent = existing
    .split("\n")
    .some((line) => line.trim() === entry);
  if (!alreadyPresent) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignorePath, `${prefix}${entry}\n`, "utf8");
  }
}

/**
 * Shared entry for the AFK bins: parse flags, handle --version/--help/--print-config,
 * resolve the workspace / package dirs, validate the positional args,
 * optionally fork into the background (--detach), then drive runLoop.
 */
export async function runBin(argv: string[], cfg: RunBinConfig): Promise<void> {
  const flags = parseFlags(argv);

  if (flags.version) {
    printVersion(cfg.bin, cfg.cliVersion);
    return;
  }
  if (flags.help) {
    printHelp(cfg.bin, cfg.usage, cfg.desc);
    return;
  }

  // run-bin.js ships in the same dist/ dir as the bin entrypoints, so ".." is
  // the installed @phamvuhoang/ralph-core package dir (which holds templates/).
  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(here, "..");
  const workspaceDir = resolve(process.env.RALPH_WORKSPACE ?? process.cwd());

  const envMaxWait = process.env.RALPH_MAX_WAIT?.trim();
  const maxWaitMs =
    flags.maxWaitMs ?? (envMaxWait ? parseDurationMs(envMaxWait) : undefined);

  const envBranch = process.env.RALPH_BRANCH?.trim();
  const branchStrategyArg =
    flags.branch ??
    (envBranch === "current" ||
    envBranch === "branch" ||
    envBranch === "worktree"
      ? envBranch
      : undefined);
  const branchPrefixArg =
    flags.branchPrefix ??
    (process.env.RALPH_BRANCH_PREFIX?.trim() || undefined);

  const detachLogPath = flags.detach
    ? (flags.log ??
      join(workspaceDir, ".ralph-tmp", "logs", `detached-${process.pid}.log`))
    : undefined;

  const DEFAULT_LENSES = ["correctness", "security", "tests"];
  const envLenses = (process.env.RALPH_REVIEW_LENSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reviewLenses =
    envLenses.length > 0
      ? envLenses
      : flags.reviewPanel
        ? DEFAULT_LENSES
        : undefined;

  if (flags.printConfig) {
    printConfig(cfg.bin, workspaceDir, packageDir, {
      cliVersion: cfg.cliVersion,
      noKeepAlive: flags.noKeepAlive,
      maxRetries: flags.maxRetries,
      detach: flags.detach,
      detachLogPath,
      notify: flags.notify,
      budget: flags.budget,
      cooldownMs: flags.cooldownMs,
      reviewLenses: reviewLenses ?? [],
      watch: flags.watch,
      watchIntervalSec: flags.watchIntervalSec,
      issue: flags.issue,
      maxWaitMs,
      branchStrategy: branchStrategyArg,
      branchPrefix: branchPrefixArg,
    });
    return;
  }

  if (flags.issue != null && !cfg.issueStage) {
    console.error("--issue is only supported by ralph-ghafk");
    process.exit(1);
  }

  const inputs =
    flags.issue != null
      ? String(flags.issue)
      : cfg.takesInputArg
        ? flags.rest[0]
        : "";
  const iterationsArg = cfg.takesInputArg ? flags.rest[1] : flags.rest[0];
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

  if (flags.issue != null) {
    if (flags.watch) {
      console.error("--issue cannot be combined with --watch");
      process.exit(1);
    }
    // Validated positive integer (parseIssueRef) — safe for the static
    // `gh issue view "$RALPH_ISSUE"` command in ghafk-issue.md. See render.ts.
    process.env.RALPH_ISSUE = String(flags.issue);
  }

  const stages =
    flags.issue != null
      ? ([cfg.issueStage!, ...cfg.stages.slice(1)] as [Stage, ...Stage[]])
      : cfg.stages;

  if (flags.detach && detachLogPath) {
    detachAndExit({
      logPath: detachLogPath,
      argv,
      binEntry: process.argv[1],
    });
  }

  const resolved = await resolveBranch({
    workspaceDir,
    inputs,
    isTTY: Boolean(process.stdout.isTTY),
    flagStrategy: branchStrategyArg,
    flagPrefix: branchPrefixArg,
  });
  process.stderr.write(`${resolved.summaryLine}\n`);
  // Evaluate the dirty-tree warning against the user's tree BEFORE we mutate the
  // workspace's .gitignore below — otherwise Ralph's own .ralph-tmp/ edit would
  // make a tracked .gitignore "dirty" and fire a spurious warning on first run.
  const dirtyWarn = dirtyTreeWarning(workspaceDir, resolved.strategy);
  if (dirtyWarn) process.stderr.write(`⚠ ${dirtyWarn}\n`);

  ensureRalphTmpIgnored(workspaceDir);

  const effectiveWorkspaceDir = resolved.effectiveWorkspaceDir;
  // state.json is written by the loop into effectiveWorkspaceDir (the worktree in
  // worktree mode), which differs from the parent workspaceDir that
  // ensureRalphTmpIgnored targets — so this stays a separate call.
  ensureStateGitignored(effectiveWorkspaceDir);

  if (flags.watch) {
    if (!cfg.supportsWatch) {
      console.error("--watch is only supported by ralph-ghafk");
      process.exit(1);
    }
    const { runWatch } = await import("./watch.js");
    await runWatch({
      stages,
      iterations,
      workspaceDir: effectiveWorkspaceDir,
      packageDir,
      watchIntervalSec: flags.watchIntervalSec ?? 300,
      watchLabel: process.env.RALPH_WATCH_LABEL?.trim() || "ralph",
      budgetUsd: flags.budget,
      cooldownMs: flags.cooldownMs,
      maxRetries: flags.maxRetries,
      reviewLenses,
      notify: flags.notify,
      bin: cfg.bin,
      cliVersion: cfg.cliVersion,
    });
    return;
  }

  await runLoop({
    stages,
    inputs: inputs ?? "",
    iterations,
    workspaceDir: effectiveWorkspaceDir,
    packageDir,
    noKeepAlive: flags.noKeepAlive,
    maxRetries: flags.maxRetries,
    notify: flags.notify,
    bin: cfg.bin,
    cliVersion: cfg.cliVersion,
    budgetUsd: flags.budget,
    cooldownMs: flags.cooldownMs,
    reviewLenses,
    mode: cfg.mode,
    maxWaitMs,
    fresh: flags.fresh,
  });
}
