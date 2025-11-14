import { parseArgs } from "@std/cli/parse-args";
import { config } from "../utils/config.ts";
import { loadEnv } from "../utils/env.ts";
import { printCliError } from "../utils/errors.ts";

const DEFAULT_BASE_IMAGE = "ubuntu:25.10";
const DEFAULT_NODE_VERSION = "24.11.0";
const DEFAULT_GO_VERSION = "1.25.4";
const DEFAULT_NPM_PACKAGES = ["@openai/codex", "@anthropic-ai/claude-code"];

const BASE_APT_PACKAGES = [
  "bash",
  "build-essential",
  "ca-certificates",
  "curl",
  "fd-find",
  "git",
  "jq",
  "openssl",
  "openssh-client",
  "python3",
  "python3-pip",
  "python3-venv",
  "ripgrep",
  "unzip",
  "wget",
  "xz-utils",
];

const textEncoder = new TextEncoder();

type BuildOptions = {
  aptPackages: string[];
  baseImage: string;
  denoVersion?: string;
  goVersion?: string;
  imageName: string;
  nodeVersion?: string;
  npmPackages: string[];
};

type ScriptStep = string | string[];

function normalizePackages(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function toCommandList(value: ScriptStep[]): string[] {
  const commands: string[] = [];
  for (const step of value) {
    if (Array.isArray(step)) {
      commands.push(...step.filter((cmd) => cmd.trim().length > 0));
    } else if (step.trim().length > 0) {
      commands.push(step);
    }
  }
  return commands;
}

function buildScript(options: BuildOptions): string[] {
  const commands: ScriptStep[] = [];
  commands.push([
    "apt-get update -qq",
    "apt-get upgrade -y -qq",
    `apt-get install -y -qq --no-install-recommends ${options.aptPackages.join(" ")}`,
    "ln -sf /usr/bin/fdfind /usr/local/bin/fd",
  ]);
  if (options.nodeVersion) {
    commands.push([
      `curl -fsSL https://nodejs.org/dist/v${options.nodeVersion}/node-v${options.nodeVersion}-linux-x64.tar.xz -o /tmp/node.tar.xz`,
      "tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1",
      "rm /tmp/node.tar.xz",
      "npm install -g npm",
    ]);
    const packages = Array.from(new Set([...DEFAULT_NPM_PACKAGES, ...options.npmPackages]));
    if (packages.length > 0) {
      commands.push(`npm install -g ${packages.join(" ")}`);
    }
  }
  if (options.denoVersion !== undefined) {
    const versionArg = options.denoVersion.length > 0 ? ` ${options.denoVersion}` : "";
    commands.push(`curl -fsSL https://deno.land/install.sh | sh -s -- --yes${versionArg}`);
  }
  if (options.goVersion) {
    commands.push([
      `curl -fsSL https://go.dev/dl/go${options.goVersion}.linux-amd64.tar.gz -o /tmp/go.tar.gz`,
      "tar -xzf /tmp/go.tar.gz -C /usr/local",
      "rm /tmp/go.tar.gz",
      "mkdir -p /go/bin /go/pkg /go/src",
      "chmod -R 777 /go",
      "echo 'export PATH=/usr/local/go/bin:/go/bin:$PATH' >> /etc/profile.d/go-path.sh",
      "echo 'export GOPATH=/go' >> /etc/profile.d/go-path.sh",
      "echo 'export GOROOT=/usr/local/go' >> /etc/profile.d/go-path.sh",
      "chmod +x /etc/profile.d/go-path.sh",
    ]);
  }
  commands.push([
    "mkdir -p /root/.ssh",
    "chmod 700 /root/.ssh",
    "ssh-keyscan -H github.com >> /root/.ssh/known_hosts 2>&1",
    "chmod 600 /root/.ssh/known_hosts",
  ]);
  return toCommandList(commands);
}

function buildDockerfile(options: BuildOptions): string {
  const commands = buildScript(options);
  const heredocTag = "SKRIBULAT_SETUP";
  const lines = [
    `FROM ${options.baseImage}`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    "WORKDIR /root",
    `RUN bash <<'${heredocTag}'`,
    "set -euo pipefail",
    ...commands,
    heredocTag,
  ];
  return `${lines.join("\n")}\n`;
}

function parseBuildOptions(argv: string[]): BuildOptions {
  const cfg = config();
  const parsed = parseArgs(argv, {
    alias: { h: "help" },
    boolean: ["help", "no-deno", "no-go", "no-node"],
    string: [
      "apt-packages",
      "base-image",
      "deno-version",
      "go-version",
      "image",
      "node-version",
      "npm-packages",
    ],
  });
  if (parsed.help) {
    console.log(
      `Usage: skribulat build-agent-runner [options]\n\n` +
        `Options:\n` +
        `  -h, --help              Show this help message\n` +
        `  --base-image <image>    Base Docker image (default ${DEFAULT_BASE_IMAGE})\n` +
        `  --image <name>          Final image tag (default from AGENT_RUNNER_IMAGE env)\n` +
        `  --node-version <ver>    Node.js version (set --no-node to skip)\n` +
        `  --go-version <ver>      Go version (set --no-go to skip)\n` +
        `  --deno-version <ver>    Deno version (empty string for latest, --no-deno to skip)\n` +
        `  --npm-packages <list>   Comma/semicolon separated global npm modules\n` +
        `  --apt-packages <list>   Additional apt packages to install\n` +
        `  --no-node               Skip Node.js installation\n` +
        `  --no-go                 Skip Go installation\n` +
        `  --no-deno               Skip Deno installation\n`,
    );
    Deno.exit(0);
  }

  const envNodeVersion = Deno.env.get("AGENT_RUNNER_NODE_VERSION");
  const envGoVersion = Deno.env.get("AGENT_RUNNER_GO_VERSION");
  const envDenoVersion = Deno.env.get("AGENT_RUNNER_DENO_VERSION");
  const envNpmPackages = Deno.env.get("AGENT_RUNNER_NPM_GLOBALS");
  const envAptPackages = Deno.env.get("AGENT_RUNNER_APT_PACKAGES");

  const nodeVersion = parsed["no-node"]
    ? undefined
    : (parsed["node-version"] as string | undefined) ?? envNodeVersion ?? DEFAULT_NODE_VERSION;
  const goVersion = parsed["no-go"]
    ? undefined
    : (parsed["go-version"] as string | undefined) ?? envGoVersion ?? DEFAULT_GO_VERSION;
  const denoVersionRaw = parsed["no-deno"]
    ? undefined
    : ((parsed["deno-version"] as string | undefined) ?? envDenoVersion ?? "");

  const npmPackages = normalizePackages(
    (parsed["npm-packages"] as string | undefined) ?? envNpmPackages,
  );
  const extraAptPackages = normalizePackages(
    (parsed["apt-packages"] as string | undefined) ?? envAptPackages,
  );
  const aptPackages = Array.from(new Set([...BASE_APT_PACKAGES, ...extraAptPackages]))
    .sort((a, b) => a.localeCompare(b));
  const imageName = (parsed.image as string | undefined) ?? cfg.agentRunnerImage;
  const baseImage = (parsed["base-image"] as string | undefined) ?? DEFAULT_BASE_IMAGE;

  return {
    aptPackages,
    baseImage,
    denoVersion: denoVersionRaw,
    goVersion,
    imageName,
    nodeVersion,
    npmPackages,
  };
}

export async function runBuildAgentRunner(argv: string[]) {
  await loadEnv();
  const options = parseBuildOptions(argv);
  const dockerfile = buildDockerfile(options);
  console.log(`> Building image ${options.imageName} from base ${options.baseImage}`);

  const buildCommand = new Deno.Command("docker", {
    args: [
      "build",
      "--platform",
      "linux/amd64",
      "-t",
      options.imageName,
      "-f",
      "-",
    ],
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = buildCommand.spawn();
  if (!child.stdin) {
    throw new Error("Failed to open stdin for docker build");
  }
  const writer = child.stdin.getWriter();
  await writer.write(textEncoder.encode(dockerfile));
  await writer.close();

  const status = await child.status;
  if (!status.success) {
    throw new Error(`docker build failed with exit code ${status.code}`);
  }
  console.log(`Built image ${options.imageName}`);
}

if (import.meta.main) {
  await runBuildAgentRunner(Deno.args).catch((error) => {
    printCliError(error);
    Deno.exit(1);
  });
}
