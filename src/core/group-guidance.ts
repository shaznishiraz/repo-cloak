export function groupGuidance(members: { directory: string; server: string }[]): string {
  return `# repo-cloak group

This directory contains independent, anonymized cloak workspaces. Work inside
the appropriate member directory; each has its own Git repository, profiles,
source mapping and AGENTS.md / CLAUDE.md instructions. Read those instructions
before editing. The original source repositories are not included here.

Member directories and their scoped MCP server names:

${members.map((member) => `- ${member.directory}/ — ${member.server}`).join('\n')}

Missing files may be intentional. Use the matching member's MCP connection to
probe exact anonymized paths, queue files, and poll request status. Paths are
relative to that member, not this group directory. Tell the user the request ID
and wait for approval in the dashboard. No agent tool can approve, Pull or Push.
Without MCP, follow that member's .repo-cloak/agent/SKILL.md HTTP instructions.
Never print or commit credentials. Do not seek original source repositories.

Start Codex from this folder and trust its project configuration to load the
member connections. Claude can use the local .mcp.json connections. Reload your
agent after changing group members. These generated group helper files are
managed by repo-cloak; keep project-specific notes in a separate file.
`;
}
