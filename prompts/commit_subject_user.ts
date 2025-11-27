export default `
Generate 3 commit proposals based on the staged changes below.
Follow the system constraints (imperative, lowercase, no prefixes).

<staged_stat>
{{STAGED_STAT}}
</staged_stat>

<staged_diff>
{{STAGED_PATCH}}
</staged_diff>

{{ADDITIONAL_GUIDANCE}}
`.trim();
