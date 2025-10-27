const template = `Repository default branch: {{DEFAULT_BRANCH}}
Current branch: {{CURRENT_BRANCH}}

You will write concise git commit subjects (single line, <=90 characters) in imperative mood.
Focus on the staged changes. Do not mention tooling or instructions. Avoid trailing punctuation.
Do not include scope prefixes (e.g. "feat:" or "api:") or tags. Keep wording lower case unless a proper noun requires capitals.

Staged diff summary (git diff --cached --stat):
{{STAGED_STAT}}

Staged diff details (git diff --cached):
{{STAGED_PATCH}}
{{BRANCH_CONTEXT}}{{ADDITIONAL_GUIDANCE}}

Respond with exactly three distinct subject options, each on its own line, prefixed with "1)", "2)", and "3)" respectively. Do not add commentary.`;

export default template;
