import { spawn } from 'node:child_process';

export type PostCommandResult = {
  command: string;
  status: 'completed' | 'failed';
  exitCode: number | null;
};

/** User-configured commands run only after successful creation; a failure keeps the workspace. */
export async function runPostCreateCommands(
  commands: string[],
  cwd: string,
): Promise<PostCommandResult[]> {
  const results: PostCommandResult[] = [];
  for (const command of commands) {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: 'ignore',
        windowsHide: true,
        timeout: 120_000,
      });
      child.once('error', () => resolve(null));
      child.once('close', (code) => resolve(code));
    });
    results.push({ command, exitCode, status: exitCode === 0 ? 'completed' : 'failed' });
    if (exitCode !== 0) break;
  }
  return results;
}
