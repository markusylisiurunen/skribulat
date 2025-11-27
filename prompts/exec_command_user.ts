export default `
Translate the user request into a non-interactive shell command.
Chain steps with "&&" if necessary. Prefer read-only git commands for inspection.

<environment_context>
{{ENV_CONTEXT}}
</environment_context>

<user_request>
{{USER_INSTRUCTION}}
</user_request>
`.trim();
