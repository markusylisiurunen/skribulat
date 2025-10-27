import { dirname } from "@std/path";
import { DockerRunner } from "./docker.ts";

export type PreserveGitPatchOptions = {
  containerTempPath?: string;
  containerWorkdir?: string;
  diffRange: string;
  hostTargetPath: string;
  quiet?: boolean;
};

export async function preserveGitPatch(
  runner: DockerRunner,
  {
    containerTempPath = "/tmp/skribulat-agent.patch",
    containerWorkdir = "/root/agent",
    diffRange,
    hostTargetPath,
    quiet = false,
  }: PreserveGitPatchOptions,
) {
  const diffArgs = diffRange.trim().length > 0 ? ` ${shellEscape(diffRange)}` : "";
  const tempTarget = shellEscape(containerTempPath);
  const commands = [
    diffArgs.length > 0 ? `git diff --patch${diffArgs}` : undefined,
    "git diff --patch --cached",
    "git diff --patch",
  ].filter((value): value is string => Boolean(value));
  const combined = commands.join("; ");
  const result = await runner.runBashCommand(
    `set -o pipefail; { ${combined}; } > ${tempTarget}`,
    { cwd: containerWorkdir },
  );
  if (result.code !== 0) {
    const details = [result.stdout, result.stderr]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join("\n");
    throw new Error(`Failed to capture git diff for preservation.${details ? `\n${details}` : ""}`);
  }
  await ensureDirectory(dirname(hostTargetPath));
  try {
    await runner.copyToHost(containerTempPath, hostTargetPath);
  } finally {
    await runner.runBashCommand(`rm -f ${tempTarget}`, { cwd: "/root" }).catch(() => {});
  }
  if (!quiet) {
    try {
      const info = await Deno.stat(hostTargetPath);
      if (info.size > 0) {
        console.log(`Preserved git patch at ${hostTargetPath}.`);
      } else {
        console.warn(`No changes detected; saved empty patch at ${hostTargetPath}.`);
      }
    } catch {
      console.warn(`Failed to inspect preserved patch at ${hostTargetPath}; assuming empty diff.`);
    }
  }
}

export function startPatchCheckpoint(
  runner: DockerRunner,
  options: PreserveGitPatchOptions & { intervalMs?: number },
) {
  const { intervalMs = 30_000 } = options;
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    preserveGitPatch(runner, { ...options, quiet: true })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to checkpoint agent patch: ${message}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (running) {
      await sleep(50);
    }
  };
}

function shellEscape(argument: string) {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

async function ensureDirectory(path: string) {
  if (!path || path === ".") return;
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return;
    throw error;
  }
}
