import commitSubjectSystem from "./commit_subject_system.ts";
import commitSubjectUser from "./commit_subject_user.ts";
import execCommandSystem from "./exec_command_system.ts";
import execCommandUser from "./exec_command_user.ts";
import planIssueSystem from "./plan_issue_system.ts";
import planIssueUser from "./plan_issue_user.ts";
import workOnIssue from "./work_on_issue.ts";
import workOnPr from "./work_on_pr.ts";

export const PROMPT_TEMPLATES: Record<string, string> = {
  "commit_subject_system.txt": commitSubjectSystem,
  "commit_subject_user.txt": commitSubjectUser,
  "exec_command_system.txt": execCommandSystem,
  "exec_command_user.txt": execCommandUser,
  "plan_issue_system.txt": planIssueSystem,
  "plan_issue_user.txt": planIssueUser,
  "work_on_issue.txt": workOnIssue,
  "work_on_pr.txt": workOnPr,
};
