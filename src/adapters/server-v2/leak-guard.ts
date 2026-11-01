import { leakIdentity, scanForLeaks } from '../../core/leak-scan.js';
import type { LeakDocument, LeakScan } from '../../core/leak-scan.js';
import type { Rule } from '../../core/rules.js';
import { runGit } from '../git.js';

const authorCommits = 200;

/**
 * Runs the heuristic scan with what Git knows about the source repository. Git failing, such as
 * for a moved source, no remote or no commits, only means fewer names to look for.
 * The findings hold real names: return them to the dashboard and do nothing else with them.
 */
export async function scanWithRepoIdentity(
  root: string,
  documents: LeakDocument[],
  rules: readonly Rule[],
  ledger: readonly { anonymized: string }[],
): Promise<LeakScan> {
  const [remoteUrl, authors] = await Promise.all([
    runGit(root, ['remote', 'get-url', 'origin']).catch(() => ''),
    runGit(root, ['log', `-${authorCommits}`, '--format=%ae']).catch(() => ''),
  ]);
  const replaced = rules.flatMap((rule) =>
    rule.type !== 'secret' && !rule.replace.includes('$') ? [rule.replace] : [],
  );
  return scanForLeaks(documents, {
    identity: leakIdentity({ remoteUrl, paths: [root], authorEmails: authors.split('\n') }),
    masks: [...replaced, ...ledger.map((entry) => entry.anonymized)],
    now: Date.now,
  });
}
