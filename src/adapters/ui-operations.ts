import type { PostCommandResult } from './post-create.js';
import { randomUUID } from 'node:crypto';

export class OperationError extends Error {
  constructor(
    readonly code: 'validation' | 'conflict' | 'stale' | 'expired' | 'busy' | 'limit' | 'unknown',
    message: string,
  ) {
    super(message);
  }
}
export type SyncResult = {
  postCommands?: PostCommandResult[];
  status: string;
  workspace: string;
  workspaceId: string;
  writes: string[];
  deletes: string[];
  replacements: number;
  skipped: number;
  warnings: string[];
  profileChanges: string[];
};
export type PreviewSummary = {
  intent: 'create' | 'refresh' | 'restore';
  source: { path: string; branch: string | null };
  destination: { path: string; branch: string | null };
  writes: string[];
  deletes: string[];
  warnings: string[];
  conflicts: string[];
  profileChanges: string[];
  replacements: number;
  canApply: boolean;
  forced: boolean;
  redactions: number;
  postCreateCommands: string[];
};
export type PreparedOperation = {
  owner?: 'group' | 'agent-request';
  summary: PreviewSummary;
  bytes: number;
  recheck?(): Promise<void>;
  apply(): Promise<SyncResult>;
};
export type OperationState = {
  operationId: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';
  expiresAt: string;
  result?: SyncResult;
  error?: string;
  code?: string;
};
export type OperationLimits = {
  now?: () => number;
  ttl?: number;
  maxPending?: number;
  maxBytes?: number;
};

/** Memory belongs to this dashboard process; no plaintext plans are persisted. */
export function createUiOperations(limits: OperationLimits = {}) {
  const now = limits.now ?? Date.now;
  const ttl = limits.ttl ?? 10 * 60_000;
  const maxPending = limits.maxPending ?? 8;
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  const operations = new Map<
    string,
    {
      state: OperationState;
      prepared?: PreparedOperation | undefined;
      finished?: number;
      task?: Promise<void> | undefined;
    }
  >();
  let preparing = 0;
  let running = false;
  let closed = false;
  function prune() {
    for (const [id, operation] of operations) {
      if (operation.state.state === 'pending' && Date.parse(operation.state.expiresAt) <= now()) {
        operation.state.state = 'expired';
        operation.prepared = undefined;
        operation.finished = now();
      }
      if (operation.finished !== undefined && operation.finished + ttl <= now())
        operations.delete(id);
    }
    const finished = [...operations].filter(([, operation]) => operation.finished !== undefined);
    for (const [id] of finished.slice(0, Math.max(0, finished.length - 32))) operations.delete(id);
  }
  const timer = setInterval(prune, Math.min(ttl, 30_000));
  timer.unref();
  function get(id: string) {
    prune();
    const operation = operations.get(id);
    if (!operation)
      throw new OperationError(
        'unknown',
        'Unknown operation; refresh status and create a new preview',
      );
    return operation;
  }
  return {
    async preview(prepare: () => Promise<PreparedOperation>) {
      prune();
      if (closed) throw new OperationError('unknown', 'Dashboard is shutting down');
      const pending = [...operations.values()].filter((operation) => operation.prepared);
      if (pending.length + preparing >= maxPending)
        throw new OperationError(
          'limit',
          'Pending preview limit reached; cancel a preview or wait for expiry',
        );
      preparing++;
      try {
        const prepared = await prepare();
        if (closed) throw new OperationError('unknown', 'Dashboard is shutting down');
        const used = [...operations.values()].reduce(
          (total, operation) => total + (operation.prepared?.bytes ?? 0),
          0,
        );
        if (prepared.bytes + used > maxBytes)
          throw new OperationError(
            'limit',
            'Preview memory limit reached; select fewer files or cancel a preview',
          );
        const operationId = randomUUID();
        const expiresAt = new Date(now() + ttl).toISOString();
        operations.set(operationId, {
          state: { operationId, state: 'pending', expiresAt },
          prepared,
        });
        return { operationId, expiresAt, ...prepared.summary };
      } finally {
        preparing--;
      }
    },
    status(id: string): OperationState {
      return { ...get(id).state };
    },
    async apply(
      id: string,
      acknowledgements: {
        deletions?: boolean | undefined;
        profiles?: boolean | undefined;
        force?: boolean | undefined;
      },
      owner?: 'group' | 'agent-request',
    ): Promise<OperationState> {
      const operation = get(id);
      if (operation.state.state === 'expired' || operation.state.state === 'cancelled')
        throw new OperationError(
          'expired',
          `Preview ${operation.state.state}; create a new preview`,
        );
      if (operation.state.state !== 'pending') return { ...operation.state };
      const prepared = operation.prepared;
      if (!prepared) throw new OperationError('unknown', 'Preview is no longer available');
      if (prepared.owner !== owner)
        throw new OperationError('validation', 'Use the group review or request review to apply this operation');
      const summary = prepared.summary;
      if (!summary.canApply)
        throw new OperationError('conflict', 'Resolve conflicts and create a new preview');
      if (summary.deletes.length && !acknowledgements.deletions)
        throw new OperationError('validation', 'Confirm the listed deletions');
      if (summary.profileChanges.length && !acknowledgements.profiles)
        throw new OperationError('validation', 'Confirm the changed profiles');
      if (summary.forced && !acknowledgements.force)
        throw new OperationError('validation', 'Confirm forced overwrites');
      if (running)
        throw new OperationError('busy', 'Another sync is running; try again after it finishes');
      running = true;
      operation.state.state = 'running';
      operation.task = Promise.resolve().then(async () => {
        try {
          operation.state.result = await prepared.apply();
          operation.state.state = 'completed';
        } catch (error) {
          operation.state.state = 'failed';
          operation.state.error = error instanceof Error ? error.message : 'Sync failed';
          operation.state.code =
            error instanceof OperationError
              ? error.code
              : /changed while|disappeared|must not exist/.test(operation.state.error)
                ? 'stale'
                : 'write';
        } finally {
          operation.prepared = undefined;
          operation.finished = now();
          operation.task = undefined;
          running = false;
          prune();
        }
      });
      return { ...operation.state };
    },
    cancel(id: string) {
      const operation = get(id);
      if (operation.state.state === 'running')
        throw new OperationError('busy', 'An active sync cannot be cancelled');
      if (operation.state.state === 'pending') {
        operation.state.state = 'cancelled';
        operation.prepared = undefined;
        operation.finished = now();
      }
      return { ...operation.state };
    },
    async exclusive<T>(action: () => Promise<T>): Promise<T> {
      if (running) throw new OperationError('busy', 'Another sync or deletion is running');
      running = true;
      try {
        return await action();
      } finally {
        running = false;
      }
    },
    async wait(id: string): Promise<OperationState> {
      const operation = get(id);
      await operation.task;
      return { ...operation.state };
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const [id, operation] of operations)
        if (operation.state.state !== 'running') operations.delete(id);
    },
  };
}
