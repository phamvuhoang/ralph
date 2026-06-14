import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStage: vi.fn(), sleep: vi.fn() }));
vi.mock("../stage-exec.js", () => ({ executeStage: mocks.executeStage }));
vi.mock("../pacing.js", () => ({ sleep: mocks.sleep }));

import { runPanel } from "../panel.js";

const ok = (result: string, costUsd = 0) => ({
  result,
  costUsd,
  isError: false,
  apiErrorStatus: null,
});

describe("runPanel", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ralph-panel-"));
    mocks.executeStage.mockReset();
    mocks.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(ws, { recursive: true, force: true });
  });

  it("runs each lens then synth, writes findings files, sums cost, returns synth result", async () => {
    mocks.executeStage.mockImplementation(
      (opts: { stage: { template: string }; vars: { LENS?: string } }) =>
        Promise.resolve(
          opts.stage.template === "review-synth.md"
            ? ok("<review>OK</review>", 0.5)
            : ok(`finding for ${opts.vars.LENS}`, 0.1)
        )
    );
    const costs: number[] = [];
    const out = await runPanel({
      lenses: ["correctness", "security", "tests"],
      workspaceDir: ws,
      packageDir: "/pkg",
      iteration: 1,
      maxRetries: 0,
      cooldownMs: 1000,
      onCost: (c) => costs.push(c),
    });
    // 3 lenses + 1 synth
    expect(mocks.executeStage).toHaveBeenCalledTimes(4);
    // order: lens templates use review-lens.md with LENS var, then synth
    const templates = mocks.executeStage.mock.calls.map(
      (c: [{ stage: { template: string } }]) => c[0].stage.template
    );
    expect(templates).toEqual([
      "review-lens.md",
      "review-lens.md",
      "review-lens.md",
      "review-synth.md",
    ]);
    // cooldown between sub-agents (after each lens) — 3 sleeps
    expect(mocks.sleep).toHaveBeenCalledTimes(3);
    // cost summed via onCost: 0.1*3 + 0.5
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.8);
    // synth result returned
    expect(out.result).toBe("<review>OK</review>");
  });
});
