import { join } from "@std/path";
import { DockerRunner } from "./docker.ts";
import { SKRIBULAT_DIRNAME, SKRIBULAT_HOOKS_SUBDIR } from "./paths.ts";

const textEncoder = new TextEncoder();

export async function runAgentHook(
  runner: DockerRunner,
  hookName: string,
  { cwd = "/root/agent" }: { cwd?: string } = {},
) {
  const hookPath = join(SKRIBULAT_DIRNAME, SKRIBULAT_HOOKS_SUBDIR, `${hookName}.sh`);
  const posixHookPath = hookPath.replaceAll("\\", "/");
  console.log(`Running hook: ${posixHookPath}`);
  const script = [
    `if [ -f "${posixHookPath}" ]; then`,
    `  chmod +x "${posixHookPath}"`,
    `  "${posixHookPath}"`,
    "else",
    "  :",
    "fi",
  ].join("\n");
  for await (const chunk of runner.streamBashCommand(script, { cwd })) {
    Deno.stdout.write(textEncoder.encode(chunk.data));
  }
  console.log(`Finished running hook: ${hookPath}`);
}
