import { useEffect, useState } from 'preact/hooks';
import type { ProfileScopeRef } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { lineOfPath, parseProblem } from './document.js';
import type { Problem } from './state.js';

export type LocatedProblem = Problem & { line?: number };
export const isError = (problem: Problem) => problem.severity !== 'warning';

/** Parse errors at once; everything else from the server, debounced while typing. */
export function useProblems(
  text: string | undefined,
  place: { scope: ProfileScopeRef; id: string | null } | undefined,
  delayMs = 250,
) {
  const [problems, setProblems] = useState<LocatedProblem[]>([]);
  useEffect(() => {
    if (text === undefined) {
      setProblems([]);
      return;
    }
    const broken = parseProblem(text);
    if (broken) {
      setProblems([{ path: '', line: broken.line, message: broken.message }]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api().call('POST /api/v2/profiles/validate', {
            body: {
              document: JSON.parse(text) as unknown,
              ...(place ? { scope: place.scope } : {}),
              ...(place?.id ? { id: place.id } : {}),
            },
          });
          if (!live) return;
          setProblems(
            (result.problems as Problem[]).map((problem) => {
              const line = lineOfPath(text, problem.path);
              return line === undefined ? problem : { ...problem, line };
            }),
          );
        } catch (error) {
          if (live)
            setProblems([
              { path: '', message: error instanceof Error ? error.message : 'Could not validate' },
            ]);
        }
      })();
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, delayMs]);
  return problems;
}

export function saveLabel(errors: number, saving: boolean) {
  if (saving) return 'Saving…';
  if (errors) return `Save · fix ${errors} error${errors === 1 ? '' : 's'}`;
  return 'Save';
}
