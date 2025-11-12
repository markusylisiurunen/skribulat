const template =
  `You will write concise git commit subjects (single line, <=90 characters) in imperative mood.
Describe the entire set of staged changes in every option—vary the wording, never the scope.
Do not mention tooling, instructions, or branches. Avoid trailing punctuation.
Do not include scope prefixes (e.g. "feat:" or "api:") or tags. Keep wording lower case unless a proper noun requires capitals.

Staged diff summary (git diff --cached --stat):
{{STAGED_STAT}}

Staged diff details (git diff --cached):
{{STAGED_PATCH}}
{{ADDITIONAL_GUIDANCE}}

Respond with exactly three distinct subject options, each on its own line, prefixed with "1)", "2)", and "3)" respectively. Do not add commentary.`;

export default template;
