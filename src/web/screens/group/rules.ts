import type { GroupDetail } from '../../api/contracts.js';

type Rules = GroupDetail['rules'];
const key = (groupId: string) => `cloak-group-rules-${groupId}`;

/** The contract has nowhere to save rules, so they are a per-browser preference for now. */
export function readRules(groupId: string, fallback: Rules): Rules {
  try {
    const saved = JSON.parse(localStorage.getItem(key(groupId)) ?? 'null') as Partial<Rules> | null;
    return {
      stopOnGuardFailure: saved?.stopOnGuardFailure ?? fallback.stopOnGuardFailure,
      sameCommitMessage: saved?.sameCommitMessage ?? fallback.sameCommitMessage,
    };
  } catch {
    return fallback;
  }
}
export function saveRules(groupId: string, rules: Rules) {
  try {
    localStorage.setItem(key(groupId), JSON.stringify(rules));
  } catch {
    /* Storage can be blocked; the rule still applies to this page. */
  }
}
