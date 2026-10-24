import { expect, it } from 'vitest';
import { createUiOperations } from '../../src/adapters/ui-operations.js';
import type { PreparedOperation } from '../../src/adapters/ui-operations.js';

function operation(apply: PreparedOperation['apply']): PreparedOperation {
  return {
    bytes: 10,
    summary: {
      intent: 'restore',
      source: { path: '/workspace', branch: null },
      destination: { path: '/source', branch: 'main' },
      writes: [],
      deletes: [],
      warnings: [],
      conflicts: [],
      profileChanges: [],
      replacements: 0,
      canApply: true,
      forced: false,
      redactions: 0,
      postCreateCommands: [],
    },
    apply,
  };
}
const result = {
  status: 'written',
  workspace: '/workspace',
  workspaceId: 'id',
  writes: [],
  deletes: [],
  replacements: 0,
  skipped: 0,
  warnings: [],
  profileChanges: [],
};
it('serializes applies and makes duplicate and lost-response retries idempotent', async () => {
  const operations = createUiOperations();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const first = await operations.preview(async () =>
    operation(async () => {
      writes++;
      await gate;
      return result;
    }),
  );
  const second = await operations.preview(async () => operation(async () => result));
  expect((await operations.apply(first.operationId, {})).state).toBe('running');
  expect((await operations.apply(first.operationId, {})).state).toBe('running');
  await expect(operations.apply(second.operationId, {})).rejects.toThrow(/running/);
  expect(() => operations.cancel(first.operationId)).toThrow(/cannot be cancelled/);
  release();
  expect((await operations.wait(first.operationId)).result).toEqual(result);
  expect((await operations.apply(first.operationId, {})).state).toBe('completed');
  expect(writes).toBe(1);
  await operations.apply(second.operationId, {});
  await operations.wait(second.operationId);
  operations.close();
});
it('releases failed plan buffers, bounds results and forgets expired and restarted operations', async () => {
  let now = 0;
  const operations = createUiOperations({ maxBytes: 10, now: () => now, ttl: 100 });
  const failed = await operations.preview(async () =>
    operation(async () => {
      throw new Error('Workspace was saved, but updating the local store failed');
    }),
  );
  await expect(operations.preview(async () => operation(async () => result))).rejects.toThrow(
    /limit/,
  );
  await operations.apply(failed.operationId, {});
  expect((await operations.wait(failed.operationId)).error).toContain('was saved');
  for (let i = 0; i < 33; i++) {
    const preview = await operations.preview(async () => operation(async () => result));
    await operations.apply(preview.operationId, {});
    await operations.wait(preview.operationId);
  }
  expect(() => operations.status(failed.operationId)).toThrow(/Unknown/);
  now = 101;
  expect(() => operations.status('unknown')).toThrow(/refresh status/);
  operations.close();
  await expect(operations.preview(async () => operation(async () => result))).rejects.toThrow(
    /shutting down/,
  );
});
it('reserves preview slots while asynchronous preparations overlap', async () => {
  const operations = createUiOperations({ maxPending: 1 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = operations.preview(async () => {
    await gate;
    return operation(async () => result);
  });
  await expect(operations.preview(async () => operation(async () => result))).rejects.toThrow(
    /limit/,
  );
  operations.close();
  release();
  await expect(first).rejects.toThrow(/shutting down/);
});

it('serializes workspace deletion with sync applies and releases the guard on failure', async () => {
  const operations = createUiOperations();
  let release = () => {};
  const pending = operations.exclusive(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    const preview = await operations.preview(async () => operation(async () => result));
    await expect(operations.apply(preview.operationId, {})).rejects.toThrow('running');
    await expect(operations.exclusive(async () => {})).rejects.toThrow('running');
    release();
    await pending;
    await expect(
      operations.exclusive(async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await operations.apply(preview.operationId, {});
    expect((await operations.wait(preview.operationId)).state).toBe('completed');
  } finally {
    release();
    operations.close();
  }
});
