import { join } from "@std/path";
import { repositoryRoot } from "./config.ts";

export const SKRIBULAT_DIRNAME = ".skribulat";
export const SKRIBULAT_CONFIG_FILENAME = "config.yaml";
export const SKRIBULAT_HOOKS_SUBDIR = "hooks";
export const SKRIBULAT_PATCHES_SUBDIR = "patches";

export function skribulatPath(...segments: string[]) {
  return join(repositoryRoot(), SKRIBULAT_DIRNAME, ...segments);
}
