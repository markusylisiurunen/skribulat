import commitSubjectSystem from "./commit_subject_system.ts";
import commitSubjectUser from "./commit_subject_user.ts";
import execCommandSystem from "./exec_command_system.ts";
import execCommandUser from "./exec_command_user.ts";
import branchNameSystem from "./branch_name_system.ts";
import grepSystem from "./grep_system.ts";
import labelGuidance from "./label_guidance.ts";
import oracleSystem from "./oracle_system.ts";
import planIssueSystem from "./plan_issue_system.ts";
import planIssueUser from "./plan_issue_user.ts";
import prBodySystem from "./pr_body_system.ts";
import reviewUser from "./review_user.ts";
import toolUseGuidance from "./tool_use_guidance.ts";
import workOnIssue from "./work_on_issue.ts";
import workOnPr from "./work_on_pr.ts";

export const PROMPT_TEMPLATES: Record<string, string> = {
  "branch_name_system.txt": branchNameSystem,
  "commit_subject_system.txt": commitSubjectSystem,
  "commit_subject_user.txt": commitSubjectUser,
  "exec_command_system.txt": execCommandSystem,
  "exec_command_user.txt": execCommandUser,
  "grep_system.txt": grepSystem,
  "label_guidance.txt": labelGuidance,
  "oracle_system.txt": oracleSystem,
  "plan_issue_system.txt": planIssueSystem,
  "plan_issue_user.txt": planIssueUser,
  "pr_body_system.txt": prBodySystem,
  "review_user.txt": reviewUser,
  "tool_use_guidance.txt": toolUseGuidance,
  "work_on_issue.txt": workOnIssue,
  "work_on_pr.txt": workOnPr,
};
