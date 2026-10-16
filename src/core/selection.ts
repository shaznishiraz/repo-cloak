import { validateRelativePath } from './paths.js';

export type Selection = {
  files?: string[];
  commits?: string[][];
  working?: string[];
  extra?: string[];
};
export function selectFiles(selection: Selection): string[] {
  const paths = [
    ...(selection.files ?? []),
    ...(selection.commits ?? []).flat(),
    ...(selection.working ?? []),
    ...(selection.extra ?? []),
  ];
  return [...new Set(paths.map(validateRelativePath))].sort();
}
