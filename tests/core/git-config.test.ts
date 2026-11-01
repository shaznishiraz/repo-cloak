import { expect, it } from 'vitest';
import { unsafeGitConfigKeys } from '../../src/core/git-config.js';

it('accepts what git init, remotes, branches and identity write', () => {
  expect(
    unsafeGitConfigKeys([
      'core.repositoryformatversion',
      'core.filemode',
      'core.bare',
      'core.logallrefupdates',
      'core.ignorecase',
      'core.precomposeunicode',
      'core.excludesFile',
      'user.name',
      'user.email',
      'remote.origin.url',
      'remote.origin.fetch',
      'branch.feature/My.Work.remote',
      'branch.main.merge',
    ]),
  ).toEqual([]);
});

it.each([
  'core.fsmonitor',
  'core.hookspath',
  'core.sshcommand',
  'core.pager',
  'core.worktree',
  'core.attributesfile',
  'filter.z.clean',
  'filter.z.smudge',
  'filter.z.process',
  'diff.external',
  'diff.z.textconv',
  'merge.z.driver',
  'include.path',
  'includeif.gitdir:/x.path',
  'alias.st',
  'credential.helper',
  'gpg.program',
  'extensions.worktreeconfig',
  'remote.origin.uploadpack',
  'remote.origin.receivepack',
  'remote.origin.proxy',
])('refuses %s, in any case', (key) => {
  expect(unsafeGitConfigKeys([key, key.toUpperCase()])).toEqual([key, key.toUpperCase()]);
});
