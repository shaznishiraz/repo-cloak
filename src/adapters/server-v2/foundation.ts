import { z } from 'zod';
import { route } from './router.js';
import type { Route } from './router.js';

const launchSchema = z.object({
  repo: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  worktree: z.string().min(1).max(4096).optional(),
  workspace: z.string().min(1).max(200).optional(),
  group: z.string().min(1).max(200).optional(),
});

export const foundationRoutes: Route[] = [
  route('GET /api/v2/session', ({ dashboard, ui, port }) => dashboard.shell.session(ui, port)),
  route('GET /api/v2/overview', ({ dashboard, query }) =>
    dashboard.shell.overview(launchSchema.parse(Object.fromEntries(query))),
  ),
  // Every screen that previews an operation shares these, so no screen package owns them.
  route('GET /api/v2/operations/:id', ({ dashboard, params }) =>
    dashboard.sync.status(params.id ?? ''),
  ),
  route('POST /api/v2/operations/:id/apply', async ({ dashboard, params, body }) =>
    dashboard.sync.apply(params.id ?? '', await body()),
  ),
  route('DELETE /api/v2/operations/:id', ({ dashboard, params }) =>
    dashboard.sync.cancel(params.id ?? ''),
  ),
];
