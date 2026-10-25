export const instructionFiles = ['AGENTS.md', 'CLAUDE.md'];
export const agentLocalPath = (path: string) => path.toLowerCase().startsWith('.codex/');
const start = '<!-- REPO-CLOAK:AGENT:START -->';
const end = '<!-- REPO-CLOAK:AGENT:END -->';
export const agentGuidance = `${start}
## repo-cloak workspace
This is a selected, anonymized copy of a private repository. Missing files may
be intentional. Use cloak_probe_files, cloak_request_files and
cloak_request_status to request only the additional anonymized paths you need.
Give the user the request ID and wait for dashboard approval and a pulled status.
Continue with available context after a denial. Do not seek the original source
or use the owner dashboard API. Read .repo-cloak/agent/SKILL.md for HTTP/MCP setup.
Never print or commit the scoped credential in .repo-cloak/agent/token.
${end}`;

export const agentSkill = `---
name: repo-cloak
description: Request missing files in a repo-cloak anonymized workspace through its scoped broker and wait for owner approval.
---

Use cloak_workspace_info to check connection and public limits. Use
cloak_probe_files with exact anonymized workspace-relative paths (absolute paths
inside this workspace also work). Do not use globs or look for the original repo.
Use cloak_request_files with necessary paths, a short reason and a unique
clientRequestId. Tell the user the returned request ID and ask them to open
Requests in the repo-cloak dashboard. Poll cloak_request_status; edit only after
the selected files report pulled. A denial is final unless the owner changes
policy; continue with existing context rather than probing alternate source paths.

Without MCP, read .repo-cloak/agent/connection.json and use its loopback baseUrl.
Read the scoped bearer credential from .repo-cloak/agent/token without displaying
it. POST /agent/v1/probe with {"paths":["src/Example.ts"]}; POST
/agent/v1/requests with {"clientRequestId":"unique-id","paths":["src/Example.ts"],"reason":"Why needed"};
GET /agent/v1/requests/<requestId> for status. These endpoints cannot approve or
pull files. If offline, ask the user to run repo-cloak and reopen the dashboard.
Do not read the source repository, owner store or dashboard token. Scoped API
access does not provide OS filesystem isolation. Approved files may be sent to
your model provider as part of the user's normal agent session.
`;

export function addAgentGuidance(text: string): string {
  if (text.includes(start) || text.includes(end))
    throw new Error('Source instructions contain a repo-cloak managed block');
  return `${text}\n\n${agentGuidance}\n`;
}
export function stripAgentGuidance(text: string): string {
  const suffix = `\n\n${agentGuidance}\n`;
  if (!text.endsWith(suffix) || text.indexOf(start) !== text.lastIndexOf(start))
    throw new Error(
      'Managed agent instructions changed; restore their generated block before pushing',
    );
  return text.slice(0, -suffix.length);
}
