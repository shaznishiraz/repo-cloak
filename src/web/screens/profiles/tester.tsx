import { useEffect, useState } from 'preact/hooks';
import type { ProfileRuleKind, ProfileSuggestion, ProfileTestResult } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { Button } from '../../shell/ui/index.js';
import type { ProfileDoc } from './rules.js';

export function Tester({ text: documentText }: { text: string }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<ProfileTestResult | null>(null);
  useEffect(() => {
    if (!text) {
      setResult(null);
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(documentText);
    } catch {
      setResult(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void api()
        .call('POST /api/v2/profiles/test', { body: { document, text } })
        .then((value) => {
          if (live) setResult(value);
        })
        .catch((error: unknown) => {
          if (live)
            setResult({
              cloaked: '',
              restored: '',
              roundTrips: false,
              problems: [
                { path: '', message: error instanceof Error ? error.message : 'Test failed' },
              ],
            });
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, documentText]);
  return (
    <section class="pf-side" aria-label="Try it">
      <div class="pf-label">Try it</div>
      <label class="pf-side-label" for="pf-try">
        Paste source text
      </label>
      <textarea
        id="pf-try"
        class="input pf-textarea pf-mono"
        rows={5}
        spellcheck={false}
        value={text}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <div class="pf-side-label">Cloaked</div>
      <output class="pf-cloaked mono" aria-label="Cloaked text">
        {result?.cloaked ?? ''}
      </output>
      <div class="pf-side-label">Round trip back</div>
      <div aria-label="Round trip result">
        {!result && <span class="pf-note">Paste text to check it.</span>}
        {result?.roundTrips && <span class="pf-ok">✓ identical to source</span>}
        {result && !result.roundTrips && <span class="pf-bad">× does not round trip</span>}
        {result?.problems.map((problem) => (
          <p key={problem.message} class="pf-row-error">
            {problem.message}
          </p>
        ))}
      </div>
    </section>
  );
}

export function Suggestions({
  repo,
  repoName,
  doc,
  onAdd,
}: {
  repo: string | undefined;
  repoName: string | undefined;
  doc: ProfileDoc | undefined;
  onAdd: (kind: ProfileRuleKind, find: string) => void;
}) {
  const [items, setItems] = useState<ProfileSuggestion[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    setItems(null);
    setFailure(null);
    if (!repo) return;
    let live = true;
    void api()
      .call('GET /api/v2/profiles/suggestions', { query: { repo } })
      .then((value) => {
        if (live) setItems(value.suggestions);
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : 'Scan failed');
      });
    return () => {
      live = false;
    };
  }, [repo]);
  const used = new Set(doc?.rules.map((rule) => rule.match));
  const open = items?.filter((item) => !used.has(item.text));
  return (
    <section class="pf-side" aria-label="Suggestions">
      <h2 class="pf-side-title">Suggestions from last scan</h2>
      {!repo && <p class="pf-note">Open repo-cloak in a repository to scan it.</p>}
      {failure && <p class="pf-row-error">{failure}</p>}
      {repo && !failure && !items && <p class="pf-note">Scanning {repoName}…</p>}
      {open && !open.length && <p class="pf-note">Nothing new in {repoName}.</p>}
      {open?.map((item) => (
        <div key={item.text} class="pf-suggestion">
          <span class="mono pf-suggest-text">{item.text}</span>
          <span class="pf-note">
            {item.reason} · {item.hits} hit{item.hits === 1 ? '' : 's'}
          </span>
          <Button
            size="small"
            variant="ghost"
            disabled={!doc}
            aria-label={`Add rule for ${item.text}`}
            onClick={() => onAdd(item.reason === 'host' ? 'keyword' : 'brand', item.text)}
          >
            add rule
          </Button>
        </div>
      ))}
    </section>
  );
}
