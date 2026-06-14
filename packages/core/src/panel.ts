import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { executeStage } from "./stage-exec.js";
import { sleep } from "./pacing.js";
import type { StageResult } from "./runner.js";
import { dim } from "./stream-render.js";

const LENS_STAGE = {
  name: "review-lens",
  template: "review-lens.md",
  permissionMode: "bypassPermissions",
};
const SYNTH_STAGE = {
  name: "review-synth",
  template: "review-synth.md",
  permissionMode: "bypassPermissions",
};

export type RunPanelOptions = {
  lenses: string[];
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  cooldownMs: number;
  signal?: AbortSignal;
  onCost?: (usd: number) => void;
};

/** Harness-orchestrated reviewer panel: read-only lens reviews → one synth fix(review) commit. */
export async function runPanel(opts: RunPanelOptions): Promise<StageResult> {
  const {
    lenses,
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    cooldownMs,
    signal,
    onCost,
  } = opts;
  const panelRel = `panel-${process.pid}-${iteration}-${Date.now()}`;
  const panelHostDir = join(workspaceDir, ".ralph-tmp", panelRel);
  mkdirSync(panelHostDir, { recursive: true });
  try {
    for (let i = 0; i < lenses.length; i++) {
      const lens = lenses[i];
      process.stderr.write(
        `${dim(`panel lens: ${lens} (${i + 1}/${lenses.length})`)}\n`
      );
      const sr = await executeStage({
        stage: LENS_STAGE,
        vars: { LENS: lens },
        workspaceDir,
        packageDir,
        iteration,
        maxRetries,
        signal,
        logLabel: `lens-${lens}`,
      });
      onCost?.(sr.costUsd);
      writeFileSync(
        join(panelHostDir, `findings-${lens}.md`),
        sr.result,
        "utf8"
      );
      if (cooldownMs > 0) await sleep(cooldownMs, signal);
    }
    process.stderr.write(`${dim("panel synth")}\n`);
    const synth = await executeStage({
      stage: SYNTH_STAGE,
      vars: { FINDINGS_DIR: `./${posix.join(".ralph-tmp", panelRel)}/` },
      workspaceDir,
      packageDir,
      iteration,
      maxRetries,
      signal,
      logLabel: "synth",
    });
    onCost?.(synth.costUsd);
    return synth;
  } finally {
    rmSync(panelHostDir, { recursive: true, force: true });
  }
}
