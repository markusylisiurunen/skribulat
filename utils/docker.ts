const textDecoder = new TextDecoder();

const activeRunners = new Set<DockerRunner>();
let cleanupRegistered = false;
let cleanupInProgress = false;

type CleanupSignal = "SIGINT" | "SIGTERM" | null;

async function cleanupAll(signal: CleanupSignal) {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  for (const runner of Array.from(activeRunners)) {
    try {
      await runner.remove();
    } catch (error) {
      console.error("Failed to remove Docker container during cleanup:", error);
    }
  }
  if (signal) {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    Deno.exit(exitCode);
  }
}

function registerCleanupHandlers() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const signals: CleanupSignal[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    if (signal) {
      Deno.addSignalListener(signal, () => {
        queueMicrotask(() => cleanupAll(signal));
      });
    }
  }
  addEventListener("unload", () => {
    queueMicrotask(() => cleanupAll(null));
  });
}

type BashOptions = {
  cwd?: string;
};

type DockerRunnerOptions = {
  envs?: Record<string, string>;
  imageName: string;
  mounts?: { containerPath: string; hostPath: string }[];
  workingDir?: string;
};

export class DockerRunner {
  private containerId?: string;

  constructor(private readonly opts: DockerRunnerOptions) {
    registerCleanupHandlers();
    activeRunners.add(this);
  }

  async commit(newImageName: string) {
    await this.ensureRunning();
    if (!this.containerId) throw new Error("Container is not running");
    await this.runNonFailingCommand(["docker", "commit", this.containerId, newImageName]);
  }

  async copyFromHost(hostPath: string, containerPath: string) {
    await this.ensureRunning();
    if (!this.containerId) throw new Error("Container is not running");
    await this.runNonFailingCommand([
      "docker",
      "cp",
      hostPath,
      `${this.containerId}:${containerPath}`,
    ]);
  }

  async copyToHost(containerPath: string, hostPath: string) {
    await this.ensureRunning();
    if (!this.containerId) throw new Error("Container is not running");
    await this.runNonFailingCommand([
      "docker",
      "cp",
      `${this.containerId}:${containerPath}`,
      hostPath,
    ]);
  }

  async runBashCommand(cmd: string, opts?: BashOptions) {
    await this.ensureRunning();
    if (!this.containerId) throw new Error("Container is not running");
    const dockerCmd: [string, ...string[]] = ["docker", "exec"];
    if (opts?.cwd) dockerCmd.push("-w", opts.cwd);
    dockerCmd.push(this.containerId, "bash", "-lc", cmd);
    return this.runCommand(dockerCmd);
  }

  async *streamBashCommand(cmd: string, opts?: BashOptions) {
    await this.ensureRunning();
    if (!this.containerId) throw new Error("Container is not running");
    const dockerCmd: [string, ...string[]] = ["docker", "exec", "-i"];
    if (opts?.cwd) dockerCmd.push("-w", opts.cwd);
    dockerCmd.push(this.containerId, "bash", "-lc", cmd);
    const command = new Deno.Command(dockerCmd[0], {
      args: dockerCmd.slice(1),
      stderr: "piped",
      stdin: "null",
      stdout: "piped",
    });
    const child = command.spawn();
    const stdoutReader = child.stdout.getReader();
    const stderrReader = child.stderr.getReader();
    let stdoutDone = false;
    let stderrDone = false;
    let stderrOutput = "";
    while (!stdoutDone || !stderrDone) {
      const promises: Promise<{
        stream: "stdout" | "stderr";
        value: ReadableStreamReadResult<Uint8Array>;
      }>[] = [];
      if (!stdoutDone) {
        promises.push(
          stdoutReader.read().then((value) => ({
            stream: "stdout" as const,
            value,
          })),
        );
      }
      if (!stderrDone) {
        promises.push(
          stderrReader.read().then((value) => ({
            stream: "stderr" as const,
            value,
          })),
        );
      }
      const result = await Promise.race(promises);
      if (result.value.done) {
        if (result.stream === "stdout") {
          stdoutDone = true;
        } else {
          stderrDone = true;
        }
      } else {
        const data = textDecoder.decode(result.value.value);
        if (result.stream === "stderr") {
          stderrOutput += data;
        }
        yield { stream: result.stream, data };
      }
    }
    const status = await child.status;
    if (!status.success) {
      throw new Error(`Command failed with exit code ${status.code}\nstderr: ${stderrOutput}`);
    }
  }

  async remove() {
    if (this.containerId) {
      await this.runNonFailingCommand(["docker", "rm", "-f", this.containerId]);
      this.containerId = undefined;
    }
    activeRunners.delete(this);
  }

  private async ensureRunning() {
    if (this.containerId) return;
    const runContainerCmd: [string, ...string[]] = ["docker", "run", "--detach", "--rm"];
    runContainerCmd.push("--platform", "linux/amd64");
    for (const mount of this.opts.mounts ?? []) {
      runContainerCmd.push("-v", `${mount.hostPath}:${mount.containerPath}`);
    }
    if (this.opts.workingDir) {
      runContainerCmd.push("-w", this.opts.workingDir);
    }
    for (const [key, value] of Object.entries(this.opts.envs ?? {})) {
      runContainerCmd.push("-e", `${key}=${value}`);
    }
    runContainerCmd.push(this.opts.imageName, "tail", "-f", "/dev/null");
    const containerId = await this.runNonFailingCommand(runContainerCmd);
    this.containerId = containerId.trim();
  }

  private async runCommand(cmd: [string, ...string[]], opts?: { cwd?: string }) {
    const command = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd: opts?.cwd,
      stderr: "piped",
      stdin: "null",
      stdout: "piped",
    });
    const { code, stderr, stdout } = await command.output();
    return {
      code,
      stderr: textDecoder.decode(stderr),
      stdout: textDecoder.decode(stdout),
    };
  }

  private async runNonFailingCommand(cmd: [string, ...string[]], opts?: { cwd?: string }) {
    const { code, stderr, stdout } = await this.runCommand(cmd, opts);
    if (code === 0) return stdout;
    throw new Error(`Command failed (code ${code}):\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}
