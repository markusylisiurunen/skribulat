export default `
Summarize the staged changes below.

<staged_stat>
{{STAGED_STAT}}
</staged_stat>

<staged_diff>
{{STAGED_PATCH}}
</staged_diff>

{{ADDITIONAL_GUIDANCE}}
`.trim();
