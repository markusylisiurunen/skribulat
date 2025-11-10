import { dirname, join, relative, resolve as resolvePath } from "@std/path";
import { load } from "@std/dotenv";
import { resolveRepoRoot } from "./git.ts";

type LoadEnvOptions = {
  cwd?: string;
  force?: boolean;
};

const loadedFiles = new Set<string>();

function buildDirectoryChain(root: string, target: string): string[] {
  const normalizedRoot = resolvePath(root);
  const normalizedTarget = resolvePath(target);
  if (!normalizedTarget.startsWith(normalizedRoot)) {
    return [normalizedRoot];
  }
  const paths: string[] = [];
  let current = normalizedTarget;
  while (true) {
    paths.push(current);
    if (current === normalizedRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths.reverse();
}

export async function loadEnv({ cwd = Deno.cwd(), force = false }: LoadEnvOptions = {}) {
  const envFilesSetting = Deno.env.get("SKRIBULAT_ENV_FILES");
  if (envFilesSetting !== undefined) {
    const normalized = envFilesSetting.trim();
    if (normalized.length > 0 && Number(normalized) === 0) {
      return;
    }
  }
  const repoRoot = resolveRepoRoot(cwd);
  const directories = buildDirectoryChain(repoRoot, cwd);
  const newlyLoaded: string[] = [];
  for (const dir of directories) {
    for (const fileName of [".env", ".env.secret"]) {
      const envPath = join(dir, fileName);
      try {
        const stat = await Deno.stat(envPath);
        if (!stat.isFile && !stat.isFifo) continue;
      } catch {
        continue;
      }
      if (!force && loadedFiles.has(envPath)) continue;
      await load({ envPath, export: true });
      loadedFiles.add(envPath);
      newlyLoaded.push(envPath);
    }
  }
  if (newlyLoaded.length > 0) {
    const relativePaths = newlyLoaded.map((path) => {
      try {
        const rel = relative(repoRoot, path);
        return rel.length > 0 ? rel : path;
      } catch {
        return path;
      }
    });
    console.log(`Loaded env files: ${relativePaths.join(", ")}`);
  }
}
