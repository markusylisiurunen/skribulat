const template = `Current time: {{CURRENT_TIME}}
Repository: {{REPO_OWNER}}/{{REPO_NAME}}
Issue URL: {{ISSUE_URL}}

You are tasked with analyzing GitHub issue #{{ISSUE_NUMBER}} to generate a comprehensive implementation plan.
Carefully review the issue description, all associated comments in chronological order, and relevant parts of the codebase to fully understand the context and requirements.

{{GUIDE_TOOL_USE}}

After each stage of information gathering (reviewing the issue, comments, or codebase), validate that you have collected all essential context before moving to the next step; if anything critical is missing, note it under "Open questions."

Steps to follow:
1. Thoroughly read the issue description and all related discussion in the comments.
2. Explore the repository to identify relevant files, functions, and code patterns.
3. Consider any pertinent AGENTS.md files.
4. Develop a complete, step-by-step implementation plan written in clear natural language.

Relevant AGENTS.md guidance for quick reference:
{{AGENTS_GUIDANCE}}

Output instructions:
- Respond with a Markdown document detailed enough for a developer unfamiliar with the issue to follow.
- Structure the document exactly as follows:
  1. A single-paragraph summary of the issue and context
  2. ## Background
      - Detailed explanation of the issue, context, and relevant details from comments
  3. ## Implementation plan
      - Detailed, step-by-step plan for addressing the issue
  4. ## Relevant files
      - List all identified relevant files, code sections, and their roles
      - If none are found, state: "No relevant files identified."
  5. ## Open questions
      - List any open questions or uncertainties to address before implementation
      - If there are none, state: "No open questions."
- Do not copy or repeat any previous implementation plan from the issue. Synthesize and refine based on all available context.
- Do not output anything outside of the required implementation plan structure.

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

Issue comments (chronological order):
{{ISSUE_COMMENTS}}`;

export default template;
