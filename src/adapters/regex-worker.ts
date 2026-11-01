import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { RegexLimitError, installRegexEngine, regexLimitMessage } from '../core/regex-engine.js';
import type { RegexEngine, RegexHit, RegexRun } from '../core/regex-engine.js';
import type { Rule } from '../core/rules.js';
import { usesScope } from '../core/variants.js';

export const regexLimits = {
  /** One regex over one text. */
  runMs: 2000,
  /** Everything one replacer runs: a pull over many files. */
  sessionMs: 60_000,
  /** One hit-counting scan. */
  scanMs: 10_000,
  startMs: 15_000,
};

/**
 * Inline and import-free, so it loads the same from the tsup bundle and under Vitest, where no
 * compiled worker file exists. A slot in `signal` tells a parked main thread that a reply is due.
 */
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { signal, port } = workerData;
parentPort.on('message', ({ source, flags, text }) => {
  let reply;
  try {
    const hits = [];
    for (const match of text.matchAll(new RegExp(source, flags + 'g'))) {
      const hit = { index: match.index, captures: [...match] };
      if (match.groups) hit.groups = { ...match.groups };
      hits.push(hit);
      if (!match[0]) break;
    }
    reply = { hits };
  } catch (error) {
    reply = { error: String(error && error.message) };
  }
  port.postMessage(reply);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
});
Atomics.store(signal, 1, 1);
Atomics.notify(signal, 1);
`;
type Reply = { hits?: RegexHit[]; error?: string };
type Job = { source: string; flags: string; text: string };

class RegexWorker {
  private readonly signal = new Int32Array(new SharedArrayBuffer(8));
  private readonly port: MessagePort;
  private readonly worker: Worker;
  private replies = 0;

  constructor() {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(workerSource, {
      eval: true,
      workerData: { signal: this.signal, port: port2 },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    // A worker that dies shows up as a missed deadline; an unheard 'error' would end the process.
    this.worker.on('error', () => undefined);
    this.worker.unref();
    this.port.unref();
  }
  private accept(reply: Reply | undefined): RegexHit[] {
    if (!reply) throw new RegexLimitError('regex worker returned no result');
    this.replies++;
    if (reply.hits) return reply.hits;
    throw new Error(reply.error ?? 'regex failed');
  }
  stop() {
    void this.worker.terminate();
    this.port.close();
  }
  /** Parks the calling thread, because core is synchronous. The first timeout ends the worker. */
  runBlocking(job: Job, limitMs: number): RegexHit[] {
    if (Atomics.wait(this.signal, 1, 0, regexLimits.startMs) === 'timed-out') {
      this.stop();
      throw new RegexLimitError('regex worker did not start');
    }
    this.worker.postMessage(job);
    if (Atomics.wait(this.signal, 0, this.replies, limitMs) === 'timed-out') {
      this.stop();
      throw new RegexLimitError(regexLimitMessage(limitMs));
    }
    return this.accept(receiveMessageOnPort(this.port)?.message as Reply | undefined);
  }
  private ready() {
    return new Promise<void>((resolve, reject) => {
      if (Atomics.load(this.signal, 1) === 1) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.stop();
        reject(new RegexLimitError('regex worker did not start'));
      }, regexLimits.startMs);
      this.worker.once('online', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  /** Leaves the event loop free. One job at a time; a timeout ends the worker. */
  async run(job: Job, limitMs: number): Promise<RegexHit[]> {
    await this.ready();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.port.removeAllListeners('message');
        this.stop();
        reject(new RegexLimitError(regexLimitMessage(limitMs)));
      }, limitMs);
      this.port.once('message', (reply: Reply) => {
        clearTimeout(timer);
        try {
          resolve(this.accept(reply));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      this.worker.postMessage(job);
    });
  }
}

/** One worker for all blocking runs, replaced after a timeout. Each replacer has its own budget. */
export function createBlockingEngine(limits = regexLimits): RegexEngine {
  let worker: RegexWorker | undefined;
  return () => {
    let spent = 0;
    return (source, flags, text) => {
      const left = limits.sessionMs - spent;
      if (left <= 0) throw new RegexLimitError(regexLimitMessage(limits.sessionMs));
      worker ??= new RegexWorker();
      const started = performance.now();
      try {
        return worker.runBlocking({ source, flags, text }, Math.min(limits.runMs, left));
      } catch (error) {
        if (error instanceof RegexLimitError) worker = undefined;
        throw error;
      } finally {
        spent += performance.now() - started;
      }
    };
  };
}

/** The regexes a replacer would run over file contents. */
export function contentPatterns(rules: readonly Rule[]) {
  return rules.flatMap((rule) =>
    rule.type === 'regex' && usesScope(rule, 'content')
      ? [{ source: rule.match, flags: rule.flags ?? '' }]
      : [],
  );
}

export function installRegexWorker() {
  installRegexEngine(createBlockingEngine());
}

/**
 * For scans and the tester: runs each pattern off-thread first, then serves those matches to the
 * synchronous replacer, so a slow regex never parks the event loop.
 */
export function createRegexScan(
  patterns: readonly { source: string; flags: string }[],
  { runMs, scanMs }: Pick<typeof regexLimits, 'runMs' | 'scanMs'> = regexLimits,
) {
  const worker = new RegexWorker();
  const deadline = performance.now() + scanMs;
  let current: { text: string; hits: Map<string, RegexHit[]> } | undefined;
  const key = (source: string, flags: string) => `${flags}/${source}`;
  const serve: RegexRun = (source, flags, text) => {
    const hits = current?.text === text ? current.hits.get(key(source, flags)) : undefined;
    if (!hits) throw new RegexLimitError('this regex was not prepared for this text');
    return hits;
  };
  return {
    engine: (() => serve) as RegexEngine,
    async prepare(text: string) {
      const hits = new Map<string, RegexHit[]>();
      for (const { source, flags } of patterns) {
        const left = deadline - performance.now();
        if (left <= 0) throw new RegexLimitError(regexLimitMessage(scanMs));
        hits.set(
          key(source, flags),
          await worker.run({ source, flags, text }, Math.min(runMs, left)),
        );
      }
      current = { text, hits };
    },
    close: () => worker.stop(),
  };
}
