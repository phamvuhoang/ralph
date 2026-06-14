import { describe, expect, it } from "vitest";

import { parseIssueRef } from "../cli-help.js";

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
  it.each(["foo", "0", "-3", "42x", "", "#", "owner/repo#", "abc#1x"])(
    "rejects %j",
    (bad) => {
      expect(() => parseIssueRef(bad)).toThrow();
    }
  );
});
