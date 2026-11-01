import { spawn } from 'node:child_process';

/** Everything else, such as session tokens and `GIT_*`, stays out of the command's environment. */
const allowedEnvironment = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TERM',
  // Windows needs these to start anything at all.
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
];
const outputLimit = 256 * 1024;
const killGrace = 5_000;

export function checkEnvironment(from: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowedEnvironment) if (from[name] !== undefined) env[name] = from[name];
  return env;
}

export type CheckResult = {
  state: 'passed' | 'failed' | 'timed-out';
  exitCode: number | null;
  durationMs: number;
  output: string;
  truncated: boolean;
};

/** Runs one user-configured command. The output is kept in memory, last 256 KiB only. */
export function runCheckCommand(command: string, cwd: string, timeoutMs: number) {
  return new Promise<CheckResult>((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: checkEnvironment(),
      windowsHide: true,
      // Its own process group, so a timeout reaches whatever the command started.
      detached: process.platform !== 'win32',
    });
    let output = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > outputLimit) {
        output = output.subarray(output.length - outputLimit);
        truncated = true;
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        // Already gone.
      }
    };
    const onExit = () => signal('SIGKILL');
    process.once('exit', onExit);
    const timers: NodeJS.Timeout[] = [];
    let finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      process.removeListener('exit', onExit);
      resolve({
        state: timedOut ? 'timed-out' : exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        durationMs: Date.now() - started,
        output: output.toString('utf8'),
        truncated,
      });
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        signal('SIGTERM');
        timers.push(
          setTimeout(() => {
            signal('SIGKILL');
            // Something may still hold the pipes open; the run is over regardless.
            timers.push(setTimeout(() => finish(null), 1_000));
          }, killGrace),
        );
      }, timeoutMs),
    );
    child.once('error', (error) => {
      collect(Buffer.from(error.message));
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}
