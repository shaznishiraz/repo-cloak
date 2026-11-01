import { signal } from '@preact/signals';
import type {
  LockedExclusion,
  ProfileDetail,
  ProfileListItem,
  ProfileProblem,
  ProfileScopeRef,
} from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { navigate } from '../../shell/router.js';
import { pretty } from './document.js';
import { asProfileDoc, blankProfile } from './rules.js';
import type { ProfileDoc } from './rules.js';

export type Problem = ProfileProblem;

/** Edits live here, not in the screen, so moving between profiles and modes loses nothing. */
export type Draft = {
  key: string;
  id: string | null;
  scope: ProfileScopeRef;
  revision: string | null;
  savedText: string;
  text: string;
  hits: Record<string, number>;
  hitsError?: string;
  locked: LockedExclusion[];
  usedBy: number;
  stale: boolean;
};
export const newKey = 'new';
export const drafts = signal<Record<string, Draft>>({});
export const profileList = signal<ProfileListItem[]>([]);
export const listError = signal<string | null>(null);

export const isDirty = (draft: Draft) => draft.id === null || draft.text !== draft.savedText;
export function docOf(draft: Draft): ProfileDoc | undefined {
  try {
    return asProfileDoc(JSON.parse(draft.text));
  } catch {
    return undefined;
  }
}
function put(draft: Draft) {
  drafts.value = { ...drafts.value, [draft.key]: draft };
}
function drop(key: string) {
  const { [key]: _gone, ...rest } = drafts.value;
  void _gone;
  drafts.value = rest;
}
export function setText(key: string, text: string) {
  const draft = drafts.value[key];
  if (draft) put({ ...draft, text });
}
export function setDoc(key: string, doc: ProfileDoc) {
  setText(key, pretty(doc));
}
export function setScope(key: string, scope: ProfileScopeRef) {
  const draft = drafts.value[key];
  if (draft) put({ ...draft, scope });
}
export function startNew(
  doc: ProfileDoc = blankProfile(),
  scope: ProfileScopeRef = { kind: 'global' },
) {
  put({
    key: newKey,
    id: null,
    scope,
    revision: null,
    savedText: '',
    text: pretty(doc),
    hits: {},
    locked: [],
    usedBy: 0,
    stale: false,
  });
}

let listRun = 0;
/** Global profiles plus each known repository's own, since a repo profile is reachable anywhere. */
export async function loadList(repoIds: string[]) {
  const run = ++listRun;
  try {
    const client = api();
    const lists = await Promise.all([
      client.call('GET /api/v2/profiles'),
      ...repoIds.map((repo) => client.call('GET /api/v2/profiles', { query: { repo } })),
    ]);
    if (run !== listRun) return;
    const byId = new Map(lists.flatMap((list) => list.profiles).map((item) => [item.id, item]));
    profileList.value = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    listError.value = null;
  } catch (error) {
    if (run === listRun)
      listError.value = error instanceof Error ? error.message : 'Could not load';
  }
}

function fromDetail(detail: ProfileDetail, previous?: Draft): Draft {
  const savedText = pretty(detail.document);
  // Unsaved edits win. Their old revision stays, so saving reports a change made elsewhere.
  const keep = previous && isDirty(previous);
  return {
    key: detail.id,
    id: detail.id,
    scope: detail.scope,
    revision: keep ? previous.revision : detail.revision,
    savedText: keep ? previous.savedText : savedText,
    text: keep ? previous.text : savedText,
    hits: detail.hits,
    ...(detail.hitsError ? { hitsError: detail.hitsError } : {}),
    locked: detail.lockedExclusions,
    usedBy: detail.usedBy,
    stale: false,
  };
}
export async function loadDetail(id: string, repo?: string) {
  const detail = await api().call('GET /api/v2/profiles/:id', {
    params: { id },
    query: repo ? { repo } : {},
  });
  put(fromDetail(detail, drafts.value[id]));
}
export async function reloadDiscarding(id: string, repo?: string) {
  drop(id);
  await loadDetail(id, repo);
}

/** Saves, or returns false when another tab changed the profile first. */
export async function saveDraft(draft: Draft, repoIds: string[], repo?: string) {
  const document: unknown = JSON.parse(draft.text);
  try {
    if (draft.id) {
      const saved = await api().call('PUT /api/v2/profiles/:id', {
        params: { id: draft.id },
        body: { revision: draft.revision ?? '', document },
      });
      drop(draft.key);
      put(fromDetail(saved));
      await loadDetail(saved.id, repo);
    } else {
      const saved = await api().call('POST /api/v2/profiles', {
        body: { scope: draft.scope, document },
      });
      put(fromDetail(saved));
      drop(newKey);
      navigate(`#/profiles/${encodeURIComponent(saved.id)}`);
    }
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      put({ ...draft, stale: true });
      return false;
    }
    throw error;
  }
  await loadList(repoIds);
  return true;
}
export async function deleteDraft(draft: Draft, repoIds: string[]) {
  if (draft.id)
    await api().call('DELETE /api/v2/profiles/:id', {
      params: { id: draft.id },
      body: { revision: draft.revision ?? '' },
    });
  drop(draft.key);
  navigate('#/profiles');
  await loadList(repoIds);
}
