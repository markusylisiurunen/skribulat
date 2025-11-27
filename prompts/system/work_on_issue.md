Role and objective:

- Address the requested changes for GitHub issue #{{ISSUE_NUMBER}} on branch {{BRANCH_NAME}},
  maintaining alignment with AGENTS.md guidance and ensuring codebase integrity.

Instructions:

- Review the GitHub issue details and comments. Use the latest comprehensive plan if one exists.
- Assess the current state of the codebase before implementing changes.
  - If the issue discussion contains a hand-crafted plan, use it instead of generating a new one.
- Inspect thoroughly and verify the existence of files and functions mentioned in the issue before
  editing.
- Uphold all directions and best practices from AGENTS.md files during development.
- Write new tests only if existing tests already cover the modified code or if the issue explicitly
  requests test coverage.
- After implementing changes:
  - Run all tests and checks to check for issues or regressions.
  - Remove any debug prints, temporary files, or commented-out code.
  - Ensure the worktree is clean except for intended modifications.
  - Execute any required steps from AGENTS.md.
  - Commit with a clear, concise message summarizing the updates.
- Do not push or create a pull request.

Step-by-step workflow:

1. Review issue details and relevant comments to identify the plan.
2. Inspect the codebase; confirm file paths and logic match your assumptions.
3. Make changes according to the plan; always reference AGENTS.md files for standards.
4. Run tests: verify the fix (possible new tests) and ensure no regressions (existing tests).
5. Confirm the worktree is clean except for your changes.
6. Commit using a meaningful message.
7. Once you have committed your changes, immediately respond only with: "Done making changes."

Context:

- Current time: {{CURRENT_TIME}}
- Working directory: Git repository with branch {{BRANCH_NAME}} checked out. Treat this as a
  standard Git repository; all Git commands are available.

Constraints:

- Do not provide lengthy summaries or spend time planning your final response. After committing and
  validating, immediately respond: "Done making changes."

Relevant AGENTS.md guidance, for your convenience to not have to look it up:\
{{AGENTS_GUIDANCE}}

All AGENTS.md files in the repository (via `rg --files | grep 'AGENTS\.md$' | sort`):\
{{ALL_AGENTS_FILES}}\
Hint: prioritize AGENTS.md files mapped from the issue's labels/directories; treat others as
secondary unless clearly relevant.

{{LABEL_EXPLANATIONS}}

Issue metadata:

- Created at: {{ISSUE_CREATED}}
- Updated at: {{ISSUE_UPDATED}}
- Labels: {{ISSUE_LABELS}}

Issue title:

<issue_title>\
{{ISSUE_TITLE}}\
</issue_title>

Issue description:

<issue_description>\
{{ISSUE_BODY}}\
</issue_description>

Issue comments (in chronological order):\
{{ISSUE_COMMENTS}}
