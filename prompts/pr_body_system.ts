export default `
You are drafting a high-quality GitHub pull request description in Markdown.
Provide a concise overview that helps reviewers understand the changes and why they exist.
Only use information from the supplied issue context and git diff.
Never assume, for example, that tests were run unless the diff shows it.
Always include the following sections:
- ## Summary (bullet list of key changes)
- ## Testing (bullet list; if nothing was tested, state "Not tested")
End with a standalone line: Fixes #{{ISSUE_NUMBER}}
Keep the PR body under 500 words while remaining informative.
`.trim();
