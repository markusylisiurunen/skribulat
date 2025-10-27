const textDecoder = new TextDecoder();

export type RunCommandOptions = {
  allowFailure?: boolean;
  cwd?: string;
};

export type CommandResult = {
  code: number;
  stderr: string;
  stdout: string;
};

export async function runCommand(
  command: string,
  args: string[],
  { allowFailure = false, cwd }: RunCommandOptions = {},
): Promise<CommandResult> {
  const denoCommand = new Deno.Command(command, {
    args,
    cwd,
    stderr: "piped",
    stdin: "null",
    stdout: "piped",
  });
  const { code, stderr, stdout } = await denoCommand.output();
  const result = {
    code,
    stderr: textDecoder.decode(stderr),
    stdout: textDecoder.decode(stdout),
  };
  if (code !== 0 && !allowFailure) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}) with code ${code}.\n${result.stderr}`,
    );
  }
  return result;
}
