import { DockerRunner } from "./docker.ts";

export const HOST_REPO_MOUNT = "/root/repo";
export const AGENT_WORKDIR = "/root/agent";

export type SetupWorkspaceOptions = {
  agentGitAuthor: { email: string; name: string };
  defaultBranch: string;
  githubOwner: string;
  githubRepo: string;
};

export async function setupAgentWorkspace(
  runner: DockerRunner,
  { agentGitAuthor, defaultBranch, githubOwner, githubRepo }: SetupWorkspaceOptions,
) {
  const httpsOrigin = `https://github.com/${githubOwner}/${githubRepo}.git`;
  const credentialHelper =
    `!f() { printf "username=%s\\npassword=%s\\n" "$GIT_CREDENTIAL_USERNAME" "$GITHUB_TOKEN"; }; f`;
  const commands = [
    `rm -rf ${AGENT_WORKDIR}`,
    `mkdir -p ${AGENT_WORKDIR}`,
    `cd ${HOST_REPO_MOUNT} && git clone --shared . ${AGENT_WORKDIR}`,
    `cd ${AGENT_WORKDIR} && git config --global user.name "${agentGitAuthor.name}"`,
    `cd ${AGENT_WORKDIR} && git config --global user.email "${agentGitAuthor.email}"`,
    `cd ${AGENT_WORKDIR} && git remote set-url origin ${httpsOrigin}`,
    `cd ${AGENT_WORKDIR} && git config credential.helper '${credentialHelper}'`,
    `cd ${AGENT_WORKDIR} && git fetch origin`,
    `cd ${AGENT_WORKDIR} && git switch -C ${defaultBranch} origin/${defaultBranch}`,
  ];
  for (const cmd of commands) {
    const { code, stderr, stdout } = await runner.runBashCommand(cmd, { cwd: "/root" });
    if (code !== 0) {
      const details = [stdout, stderr].filter((part) => part.trim().length > 0).join("\n");
      throw new Error(`Agent workspace setup failed: ${cmd}${details ? `\n${details}` : ""}`);
    }
  }
}

export async function verifyGithubHttps(
  runner: DockerRunner,
  { remote = "origin", ref = "HEAD", workdir = AGENT_WORKDIR }: {
    remote?: string;
    ref?: string;
    workdir?: string;
  } = {},
) {
  const command = `git ls-remote ${remote} ${ref}`;
  const { code, stderr } = await runner.runBashCommand(command, { cwd: workdir });
  if (code !== 0) {
    const message = stderr.trim().length > 0
      ? stderr.trim()
      : "Unknown error running git ls-remote.";
    throw new Error(`Failed to authenticate with GitHub over HTTPS: ${message}`);
  }
  console.log("Verified GitHub HTTPS authentication inside agent runner.");
}
