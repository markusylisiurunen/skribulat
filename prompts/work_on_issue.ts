const template = `Role and objective:
- Address the requested changes for GitHub issue #{{ISSUE_NUMBER}} on branch {{BRANCH_NAME}},
  maintaining alignment with AGENTS.md guidance and ensuring codebase integrity.

Instructions:
- Review the GitHub issue details and comments. Use the latest comprehensive plan if one exists.
- Assess the current state of the codebase before implementing changes.
  - If the issue discussion contains a hand-crafted plan, use it instead of generating a new one.
- Inspect thoroughly and verify the existence of files and functions mentioned in the issue before editing.
- Uphold all directions and best practices from AGENTS.md files during development.
- After implementing changes:
  - Run existing tests related to the changes, not just new tests.
  - Remove any debug prints, temporary files, or commented-out code.
  - Ensure the worktree is clean except for intended modifications.
  - Execute any required steps from AGENTS.md.
  - Commit with a clear, concise message summarizing the updates.
- After committing, immediately validate that all intended modifications are present and tests pass.
  If validation fails, self-correct then repeat the validation step.
- Do not push or create a pull request.

Step-by-step workflow:
1. Review issue details and relevant comments to identify the plan.
2. Inspect the codebase; confirm file paths and logic match your assumptions.
3. Make changes according to the plan; always reference AGENTS.md files for standards.
4. Run existing tests and checks related to your changes, not just any new tests, to ensure no regressions.
5. Confirm the worktree is clean except for your changes.
6. Commit using a meaningful message.
7. After validating the commit, immediately respond only with: "Done making changes."

Context:
- Current time: {{CURRENT_TIME}}
- Working directory: Git repository with branch {{BRANCH_NAME}} checked out. Treat this as a
  standard Git repository; all Git commands are available.

Constraints:
- Do not provide lengthy summaries or spend time planning your final response. After committing and
  validating, immediately respond: "Done making changes."

Relevant AGENTS.md guidance, for your convenience to not have to look it up:
{{AGENTS_GUIDANCE}}

{{LABEL_EXPLANATIONS}}

Issue metadata:
- Created at: {{ISSUE_CREATED}}
- Updated at: {{ISSUE_UPDATED}}
- Labels: {{ISSUE_LABELS}}

Issue title:
<title>
{{ISSUE_TITLE}}
</title>

Issue description:
<description>
{{ISSUE_BODY}}
</description>

Issue comments (in chronological order):
{{ISSUE_COMMENTS}}`;

export default template;
