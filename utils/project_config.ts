import { parse } from "@std/yaml";
import { SKRIBULAT_CONFIG_FILENAME, skribulatPath } from "./paths.ts";

export type AgentToolConfig = {
  command?: string;
  env?: Record<string, string>;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
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

export type ProjectConfig = {
  agent?: AgentToolConfig;
  planIssue?: PlanIssueConfig;
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
    if (effort === "minimal" || effort === "low" || effort === "medium" || effort === "high") {
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
