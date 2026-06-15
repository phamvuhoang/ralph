import { describe, expect, it } from "vitest";

import { parseFlags, parseIssueRef } from "../cli-help.js";

describe("parseIssueRef", () => {
  it("accepts a bare number", () => {
    expect(parseIssueRef("42")).toBe(42);
  });
  it("accepts the #N hash form", () => {
    expect(parseIssueRef("#42")).toBe(42);
  });
  it("accepts the owner/repo#N form", () => {
    expect(parseIssueRef("phamvuhoang/ralph#42")).toBe(42);
  });
  it("accepts a GitHub issue URL", () => {
    expect(
      parseIssueRef("https://github.com/phamvuhoang/ralph/issues/42")
    ).toBe(42);
  });
  it("accepts an issue URL with a comment anchor", () => {
    expect(
      parseIssueRef(
        "https://github.com/phamvuhoang/ralph/issues/42#issuecomment-99"
      )
    ).toBe(42);
  });
  it("trims surrounding whitespace", () => {
    expect(parseIssueRef("  42  ")).toBe(42);
  });
  it.each(["foo", "0", "007", "-3", "42x", "", "#", "owner/repo#", "abc#1x"])(
    "rejects %j",
    (bad) => {
      expect(() => parseIssueRef(bad)).toThrow();
    }
  );
  it("rejects an unsafe, absurdly large number", () => {
    expect(() => parseIssueRef("99999999999999999999")).toThrow();
  });
});

describe("parseFlags --issue", () => {
  it("parses --issue into a number", () => {
    expect(parseFlags(["--issue", "42", "5"]).issue).toBe(42);
  });
  it("leaves issue undefined when absent", () => {
    expect(parseFlags(["5"]).issue).toBeUndefined();
  });
  it("keeps iterations as the trailing positional", () => {
    expect(parseFlags(["--issue", "42", "5"]).rest).toEqual(["5"]);
  });
  it("throws when --issue has no value", () => {
    expect(() => parseFlags(["--issue"])).toThrow("--issue requires a value");
  });
  it("throws when --issue value is invalid", () => {
    expect(() => parseFlags(["--issue", "foo", "5"])).toThrow();
  });
});

describe("parseFlags --branch / --branch-prefix", () => {
  it("parses --branch and --branch-prefix", () => {
    const f = parseFlags([
      "--branch",
      "worktree",
      "--branch-prefix",
      "bot/",
      "5",
    ]);
    expect(f.branch).toBe("worktree");
    expect(f.branchPrefix).toBe("bot/");
    expect(f.rest).toEqual(["5"]);
  });
  it("rejects an invalid --branch value", () => {
    expect(() => parseFlags(["--branch", "nope"])).toThrow(/--branch must be/);
  });
  it("errors when --branch has no value", () => {
    expect(() => parseFlags(["--branch"])).toThrow(/--branch requires a value/);
  });
});
