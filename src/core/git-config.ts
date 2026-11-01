/**
 * Local Git config keys repo-cloak accepts in a cloak workspace. An agent can write to that
 * workspace, and many other keys run commands (`core.fsmonitor`, `filter.*.clean`, `diff.external`,
 * `include.path` pulling in anything), so the list names what is safe rather than what is not.
 */
const exact = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'core.autocrlf',
  'core.safecrlf',
  'core.eol',
  'core.quotepath',
  'core.longpaths',
  'core.excludesfile', // Only hides paths from Git; workspace commits force-add theirs.
  'extensions.objectformat',
  'extensions.refstorage',
  'commit.gpgsign',
  'tag.gpgsign',
  'init.defaultbranch',
  'pull.rebase',
  'pull.ff',
  'push.default',
  'fetch.prune',
]);
const identity = /^(?:user|author|committer)\.[a-z]+$/;
const branch = /^branch\..+\.(?:remote|merge|rebase)$/s;
const remote = /^remote\..+\.(?:url|pushurl|fetch)$/s;

/** Keys as `git config --name-only --list` prints them. Returns those Git could act on unsafely. */
export function unsafeGitConfigKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const name = key.toLowerCase();
    return !exact.has(name) && !identity.test(name) && !branch.test(name) && !remote.test(name);
  });
}
