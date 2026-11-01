import { EmptyState } from './ui/index.js';

/** Stands in for a screen until its work package replaces it. */
export function Placeholder({
  title,
  package: owner,
  detail,
}: {
  title: string;
  package: string;
  detail?: string | undefined;
}) {
  return (
    <main class="screen" aria-label={title} data-placeholder={owner}>
      <EmptyState title={title}>
        This screen arrives with work package {owner}.
        {detail && <span class="mono"> {detail}</span>}
      </EmptyState>
    </main>
  );
}
