import { AgentToolConfig } from "./project_config.ts";

export function buildRunnerEnv(
  baseEnv: Record<string, string>,
  agentConfig?: AgentToolConfig,
): Record<string, string> {
  const merged: Record<string, string> = { ...baseEnv };
  if (!agentConfig) {
    return merged;
  }
  if (agentConfig.env) {
    for (const [key, value] of Object.entries(agentConfig.env)) {
      merged[key] = value;
    }
  }
  if (agentConfig.envPassthrough) {
    for (const key of agentConfig.envPassthrough) {
      const envKey = key.trim();
      if (!envKey) continue;
      const hostValue = Deno.env.get(envKey);
      if (hostValue !== undefined) {
        merged[envKey] = hostValue;
      }
    }
  }
  return merged;
}
