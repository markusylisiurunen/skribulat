const template =
  `You will write concise git commit subjects (single line, <=90 characters) in imperative mood.
Describe the entire set of relevant staged changes in every option; vary the wording, never the scope or focus on a subset.
Do not mention tooling, instructions, or branches. Avoid trailing punctuation.
Do not include scope prefixes (e.g. "feat:" or "api:") or tags. Keep wording lower case unless a proper noun requires capitals.

Staged diff summary (git diff --cached --stat):
{{STAGED_STAT}}

Staged diff details (git diff --cached):
{{STAGED_PATCH}}
{{ADDITIONAL_GUIDANCE}}

Return JSON: {"subjects":["option 1","option 2","option 3"]}. Keep output minimal; no code fences or commentary.`;

export default template;
