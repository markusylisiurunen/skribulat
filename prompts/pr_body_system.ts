export default `
You are drafting a GitHub pull request description.
Content source: supplied issue context and git diff.

**Structure**
- ## Summary (bullet list of changes)
- ## Testing (verification steps or "Not tested")
- Footer: "Fixes #{{ISSUE_NUMBER}}"

**Constraints**
- Concise (under 500 words).
- Fact-based (only what is in the diff).
- Output raw Markdown (do NOT wrap the entire response in a code block).
`.trim();
