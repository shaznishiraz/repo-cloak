import { runPostCreateCommands } from './post-create.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import * as files from './files.js';
import * as git from './git.js';
import * as worktree from './worktree.js';
import { createProfileStore } from './profiles.js';
import { createStore } from './store.js';
import { createSyncStore } from './sync-store.js';
import { createWorkspaceWriter } from './workspace.js';
import { createSourceWriter } from './source-writer.js';
import { createAgentStore } from './agent-store.js';
import { installRegexWorker } from './regex-worker.js';

export function createSyncServices(cwd = process.cwd(), store = createStore()) {
  // Every production path reaches a replacer through these services.
  installRegexWorker();
  return {
    cwd: resolve(cwd),
    agentAccess: createAgentStore(store),
    runPostCreateCommands,
    beforeApply: undefined as (() => Promise<void>) | undefined,
    store: createSyncStore(store),
    profiles: createProfileStore(store),
    files,
    git,
    worktree,
    writeWorkspace: createWorkspaceWriter(),
    writeSource: createSourceWriter(),
    now: () => new Date().toISOString(),
    newId: randomUUID,
  };
}
export type SyncServices = ReturnType<typeof createSyncServices>;
