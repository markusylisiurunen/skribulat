import { parse } from "@std/yaml";
import { SKRIBULAT_CONFIG_FILENAME, skribulatPath } from "./paths.ts";

export type AgentToolConfig = {
  command?: string;
  env?: Record<string, string>;
  envPassthrough?: string[];
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  tool?: "codex" | "claude-code" | "shell";
};

export type AgentConfigSection = {
  agent?: AgentToolConfig;
};

export type PlanIssueConfig = AgentConfigSection & {
  agentsDirectoryMap?: Record<string, string[]>;
  labelExplanations?: string;
  toolGuidance?: string;
};

export type GrepFragmentConfig = {
  name: string;
  include: string[];
  exclude?: string[];
  splits?: GrepFragmentSplitConfig[];
};

export type GrepFragmentSplitConfig = {
  name?: string;
  include?: string[];
  exclude?: string[];
};

export type GrepConfig = {
  fragments?: GrepFragmentConfig[];
  defaultModel?: string;
};

export type ProjectConfig = {
  agent?: AgentToolConfig;
  planIssue?: PlanIssueConfig;
  grep?: GrepConfig;
  workOnIssue?: AgentConfigSection;
  workOnPr?: AgentConfigSection;
};

const CONFIG_PATH = skribulatPath(SKRIBULAT_CONFIG_FILENAME);

let cachedConfig: ProjectConfig | null = null;
let attemptedLoad = false;

function fileExists(path: string): boolean {
  try {
    const stat = Deno.statSync(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

function parseYaml(contents: string): ProjectConfig {
  const parsed = parse(contents);
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  const root = parsed as Record<string, unknown>;
  const agent = extractAgentConfig(root["agent"]);
  const planIssueRaw = root["plan_issue"];
  const planIssue = planIssueRaw && typeof planIssueRaw === "object"
    ? normalizePlanIssueConfig(planIssueRaw as Record<string, unknown>)
    : undefined;
  const grepRaw = root["grep"];
  const grep = grepRaw && typeof grepRaw === "object"
    ? normalizeGrepConfig(grepRaw as Record<string, unknown>)
    : undefined;
  const workOnIssueRaw = root["work_on_issue"];
  const workOnIssue = workOnIssueRaw && typeof workOnIssueRaw === "object"
    ? normalizeAgentSection(workOnIssueRaw as Record<string, unknown>)
    : undefined;
  const workOnPrRaw = root["work_on_pr"];
  const workOnPr = workOnPrRaw && typeof workOnPrRaw === "object"
    ? normalizeAgentSection(workOnPrRaw as Record<string, unknown>)
    : undefined;
  return {
    agent,
    planIssue,
    grep,
    workOnIssue,
    workOnPr,
  };
}

function normalizePlanIssueConfig(raw: Record<string, unknown>): PlanIssueConfig {
  const config: PlanIssueConfig = {};
  if (typeof raw["label_explanations"] === "string") {
    config.labelExplanations = raw["label_explanations"] as string;
  }
  if (typeof raw["tool_guidance"] === "string") {
    config.toolGuidance = raw["tool_guidance"] as string;
  }
  const mapRaw = raw["agents_directory_map"];
  if (mapRaw && typeof mapRaw === "object") {
    const map: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(mapRaw as Record<string, unknown>)) {
      if (!key) continue;
      if (Array.isArray(value)) {
        const paths = value
          .map((item) => typeof item === "string" ? item.trim() : "")
          .filter((item) => item.length > 0);
        if (paths.length > 0) {
          map[key] = paths;
        }
      } else if (typeof value === "string" && value.trim().length > 0) {
        map[key] = [value.trim()];
      }
    }
    const normalizedEntries = Object.entries(map).map(([label, paths]) => (
      [label.trim().toLowerCase(), paths] as const
    ));
    if (normalizedEntries.length > 0) {
      config.agentsDirectoryMap = Object.fromEntries(normalizedEntries);
    }
  }
  const agentRaw = raw["agent"];
  if (agentRaw && typeof agentRaw === "object") {
    config.agent = normalizeAgentConfig(agentRaw as Record<string, unknown>);
  }
  return config;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return [];
}

function normalizeSplits(raw: unknown): GrepFragmentSplitConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const splits: GrepFragmentSplitConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const nameRaw = record["name"];
    const include = toStringArray(record["include"]);
    const exclude = toStringArray(record["exclude"]);
    if (include.length === 0) continue; // must have an include to be meaningful
    const name = typeof nameRaw === "string" && nameRaw.trim().length > 0
      ? nameRaw.trim()
      : undefined;
    splits.push({
      name,
      include,
      exclude: exclude.length > 0 ? exclude : undefined,
    });
  }
  return splits.length > 0 ? splits : undefined;
}

function normalizeGrepConfig(raw: Record<string, unknown>): GrepConfig {
  const config: GrepConfig = {};
  const fragmentsRaw = raw["fragments"];
  const defaultModelRaw = raw["default_model"];
  if (typeof defaultModelRaw === "string" && defaultModelRaw.trim().length > 0) {
    config.defaultModel = defaultModelRaw.trim();
  }
  if (Array.isArray(fragmentsRaw)) {
    const fragments: GrepFragmentConfig[] = [];
    for (const entry of fragmentsRaw) {
      if (!entry || typeof entry !== "object") continue;
      const nameRaw = (entry as Record<string, unknown>)["name"];
      const includeRaw = (entry as Record<string, unknown>)["include"];
      const excludeRaw = (entry as Record<string, unknown>)["exclude"];
      const splitsRaw = (entry as Record<string, unknown>)["splits"];
      const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
      const include = toStringArray(includeRaw);
      const exclude = toStringArray(excludeRaw);
      const splits = normalizeSplits(splitsRaw);
      if (!name || include.length === 0) continue;
      fragments.push({
        name,
        include,
        exclude: exclude.length > 0 ? exclude : undefined,
        splits,
      });
    }
    if (fragments.length > 0) {
      config.fragments = fragments;
    }
  }
  return config;
}

function normalizeAgentSection(raw: Record<string, unknown>): AgentConfigSection {
  const agentRaw = raw["agent"];
  if (agentRaw && typeof agentRaw === "object") {
    return { agent: normalizeAgentConfig(agentRaw as Record<string, unknown>) };
  }
  return {};
}

function extractAgentConfig(value: unknown): AgentToolConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  return normalizeAgentConfig(value as Record<string, unknown>);
}

function mergeEnv(
  base?: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function mergeEnvPassthrough(
  base?: string[],
  override?: string[],
): string[] | undefined {
  if (!base && !override) return undefined;
  const combined = [...(base ?? []), ...(override ?? [])].map((value) => value.trim()).filter((
    value,
  ) => value.length > 0);
  return Array.from(new Set(combined));
}

export function mergeAgentConfigs(
  ...configs: (AgentToolConfig | undefined)[]
): AgentToolConfig {
  const merged: AgentToolConfig = {};
  for (const config of configs) {
    if (!config) continue;
    if (config.tool) merged.tool = config.tool;
    if (config.command) merged.command = config.command;
    if (config.model) merged.model = config.model;
    if (config.reasoningEffort) merged.reasoningEffort = config.reasoningEffort;
    merged.env = mergeEnv(merged.env, config.env);
    merged.envPassthrough = mergeEnvPassthrough(merged.envPassthrough, config.envPassthrough);
  }
  return merged;
}

function normalizeTool(value?: string): AgentToolConfig["tool"] | undefined {
  if (!value) return undefined;
  const tool = value.toLowerCase();
  if (tool === "codex" || tool === "claude-code" || tool === "shell") {
    return tool;
  }
  return undefined;
}

function normalizeReasoningEffort(
  value?: string,
): AgentToolConfig["reasoningEffort"] | undefined {
  if (!value) return undefined;
  const effort = value.toLowerCase();
  if (
    effort === "none" || effort === "minimal" || effort === "low" || effort === "medium" ||
    effort === "high"
  ) {
    return effort;
  }
  return undefined;
}

export type AgentCliOverrides = {
  tool?: string;
  model?: string;
  command?: string;
  reasoningEffort?: string;
};

export type AgentConfigTarget = "plan_issue" | "work_on_issue" | "work_on_pr";

export function resolveAgentConfig(
  projectConfig: ProjectConfig,
  target: AgentConfigTarget,
  cliOverrides: AgentCliOverrides = {},
): AgentToolConfig {
  const targetConfig = (() => {
    switch (target) {
      case "plan_issue":
        return projectConfig.planIssue?.agent;
      case "work_on_issue":
        return projectConfig.workOnIssue?.agent;
      case "work_on_pr":
        return projectConfig.workOnPr?.agent;
      default:
        return undefined;
    }
  })();
  const merged = mergeAgentConfigs(projectConfig.agent, targetConfig);
  const overrideConfig: AgentToolConfig = {};
  overrideConfig.tool = normalizeTool(cliOverrides.tool) ?? merged.tool;
  overrideConfig.model = cliOverrides.model?.trim().length
    ? cliOverrides.model.trim()
    : merged.model;
  overrideConfig.command = cliOverrides.command?.trim().length
    ? cliOverrides.command.trim()
    : merged.command;
  overrideConfig.reasoningEffort = normalizeReasoningEffort(cliOverrides.reasoningEffort) ??
    merged.reasoningEffort;
  overrideConfig.env = merged.env;
  overrideConfig.envPassthrough = merged.envPassthrough;
  return overrideConfig;
}

function normalizeAgentConfig(raw: Record<string, unknown>): AgentToolConfig {
  const agent: AgentToolConfig = {};
  if (typeof raw["tool"] === "string") {
    const tool = raw["tool"].toLowerCase();
    if (tool === "codex" || tool === "claude-code" || tool === "shell") {
      agent.tool = tool;
    }
  }
  if (typeof raw["command"] === "string") {
    const cmd = raw["command"].trim();
    if (cmd.length > 0) agent.command = cmd;
  }
  if (typeof raw["model"] === "string") {
    const model = raw["model"].trim();
    if (model.length > 0) agent.model = model;
  }
  if (typeof raw["reasoning_effort"] === "string") {
    const effort = raw["reasoning_effort"].toLowerCase();
    if (
      effort === "none" || effort === "minimal" || effort === "low" || effort === "medium" ||
      effort === "high"
    ) {
      agent.reasoningEffort = effort;
    }
  }
  const envRaw = raw["env"];
  if (envRaw && typeof envRaw === "object") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
      if (typeof value === "string") {
        env[key] = value;
      }
    }
    if (Object.keys(env).length > 0) {
      agent.env = env;
    }
  }
  const passThroughRaw = raw["env_passthrough"];
  if (passThroughRaw) {
    const keys = Array.isArray(passThroughRaw) ? passThroughRaw : [passThroughRaw];
    const normalized = keys
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const unique = Array.from(new Set(normalized));
    if (unique.length > 0) {
      agent.envPassthrough = unique;
    }
  }
  return agent;
}

export function loadProjectConfig(): ProjectConfig {
  if (cachedConfig) return cachedConfig;
  if (attemptedLoad) return {};
  attemptedLoad = true;
  if (!fileExists(CONFIG_PATH)) {
    cachedConfig = {};
    return cachedConfig;
  }
  try {
    const contents = Deno.readTextFileSync(CONFIG_PATH);
    cachedConfig = parseYaml(contents);
  } catch (error) {
    console.warn(
      `Warning: failed to load project config from ${CONFIG_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    cachedConfig = {};
  }
  return cachedConfig;
}
