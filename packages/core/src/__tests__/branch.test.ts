import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dirtyTreeWarning,
  ensureRalphTmpIgnored,
  readBranchConfig,
  resolveBranch,
  slugify,
  writeBranchConfig,
} from "../branch.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ralph-cfg-"));
}

function tmpRepo2(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-rb-"));
  execFileSync("git", ["init", "-qb", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "f.txt"), "1");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const base = (dir: string) => ({
  workspaceDir: dir,
  inputs: "plan-x.md",
  isTTY: false,
  now: () => "20260615-1200",
});

describe("slugify", () => {
  it("takes the basename of the first path token, drops extension", () => {
    expect(slugify("docs/2026-06-15-analytics.md other.md")).toBe(
      "2026-06-15-analytics"
    );
  });
  it("uses the first token's basename: lowercases, collapses non-alnum to dashes", () => {
    expect(slugify("docs/Add__Login!!.md other.md")).toBe("add-login");
  });
  it("caps length at 40 chars without trailing dash", () => {
    const s = slugify("a".repeat(60) + ".md");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
  it("returns empty string for empty input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("branch config", () => {
  it("returns empty object when .ralph/config.json is absent", () => {
    expect(readBranchConfig(tmpDir())).toEqual({});
  });
  it("returns empty object on malformed JSON (never throws)", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".ralph"));
    writeFileSync(join(dir, ".ralph", "config.json"), "{ not json");
    expect(readBranchConfig(dir)).toEqual({});
  });
  it("round-trips a written config", () => {
    const dir = tmpDir();
    writeBranchConfig(dir, {
      branchStrategy: "worktree",
      branchPrefix: "ralph/",
    });
    expect(readBranchConfig(dir)).toEqual({
      branchStrategy: "worktree",
      branchPrefix: "ralph/",
    });
  });
  it("merges into an existing config, preserving unknown keys", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".ralph"));
    writeFileSync(
      join(dir, ".ralph", "config.json"),
      JSON.stringify({ extra: 1 })
    );
    writeBranchConfig(dir, { branchStrategy: "branch" });
    const raw = JSON.parse(
      readFileSync(join(dir, ".ralph", "config.json"), "utf8")
    );
    expect(raw.extra).toBe(1);
    expect(raw.branchStrategy).toBe("branch");
  });
});

describe("resolveBranch", () => {
  it("defaults to current (no flag, no config, non-TTY)", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch(base(dir));
    expect(r.strategy).toBe("current");
    expect(r.branchName).toBeNull();
    expect(r.effectiveWorkspaceDir).toBe(dir);
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir })
        .toString()
        .trim()
    ).toBe("main");
  });

  it("flag wins over config", async () => {
    const dir = tmpRepo2();
    writeBranchConfig(dir, { branchStrategy: "worktree" });
    const r = await resolveBranch({ ...base(dir), flagStrategy: "branch" });
    expect(r.strategy).toBe("branch");
    expect(r.branchName).toBe("ralph/plan-x");
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: dir })
        .toString()
        .trim()
    ).toBe("ralph/plan-x");
  });

  it("config supplies the learned default", async () => {
    const dir = tmpRepo2();
    writeBranchConfig(dir, { branchStrategy: "branch", branchPrefix: "bot/" });
    const r = await resolveBranch(base(dir));
    expect(r.strategy).toBe("branch");
    expect(r.branchName).toBe("bot/plan-x");
  });

  it("worktree mode returns a worktree dir under .ralph-tmp/worktrees", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({ ...base(dir), flagStrategy: "worktree" });
    expect(r.strategy).toBe("worktree");
    expect(r.effectiveWorkspaceDir).toBe(
      join(dir, ".ralph-tmp", "worktrees", "plan-x")
    );
    expect(existsSync(r.effectiveWorkspaceDir)).toBe(true);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: r.effectiveWorkspaceDir,
      })
        .toString()
        .trim()
    ).toBe("ralph/plan-x");
  });

  it("appends -2 on branch-name collision", async () => {
    const dir = tmpRepo2();
    execFileSync("git", ["branch", "ralph/plan-x"], { cwd: dir });
    const r = await resolveBranch({ ...base(dir), flagStrategy: "branch" });
    expect(r.branchName).toBe("ralph/plan-x-2");
  });

  it("falls back to a timestamp slug when inputs are empty (ghafk)", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({
      ...base(dir),
      inputs: "",
      flagStrategy: "branch",
    });
    expect(r.branchName).toBe("ralph/20260615-1200");
  });

  it("errors for branch/worktree when not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-norepo-"));
    await expect(
      resolveBranch({ ...base(dir), flagStrategy: "branch" })
    ).rejects.toThrow(/git repo/i);
  });

  it("prompts when TTY and unresolved, and remembers on yes", async () => {
    const dir = tmpRepo2();
    const r = await resolveBranch({
      ...base(dir),
      isTTY: true,
      prompt: async () => ({ strategy: "branch" as const, remember: true }),
    });
    expect(r.strategy).toBe("branch");
    expect(readBranchConfig(dir).branchStrategy).toBe("branch");
  });
});

describe("ensureRalphTmpIgnored", () => {
  it("adds .ralph-tmp/ to .gitignore (creating the file) and is idempotent", () => {
    const dir = tmpRepo2();
    ensureRalphTmpIgnored(dir);
    const after = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(after).toContain(".ralph-tmp/");
    ensureRalphTmpIgnored(dir); // second call must not duplicate
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(after);
  });
  it("does not duplicate when a .ralph-tmp entry already exists", () => {
    const dir = tmpRepo2();
    writeFileSync(join(dir, ".gitignore"), ".ralph-tmp\n");
    ensureRalphTmpIgnored(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".ralph-tmp\n");
  });
  it("only adds .ralph-tmp, never .ralph itself", () => {
    const dir = tmpRepo2();
    ensureRalphTmpIgnored(dir);
    const lines = readFileSync(join(dir, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    expect(lines).not.toContain(".ralph");
    expect(lines).not.toContain(".ralph/");
  });
  it("no-ops outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-nogit-"));
    expect(() => ensureRalphTmpIgnored(dir)).not.toThrow();
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});

describe("dirtyTreeWarning", () => {
  it("warns on a dirty tree for non-worktree strategies", () => {
    const dir = tmpRepo2();
    writeFileSync(join(dir, "f.txt"), "changed");
    expect(dirtyTreeWarning(dir, "current")).toMatch(/uncommitted/);
    expect(dirtyTreeWarning(dir, "worktree")).toBeNull();
  });
  it("no warning on a clean tree", () => {
    expect(dirtyTreeWarning(tmpRepo2(), "current")).toBeNull();
  });
});
