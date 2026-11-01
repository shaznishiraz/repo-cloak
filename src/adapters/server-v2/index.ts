import { adminRoutes } from './admin.js';
import { foundationRoutes } from './foundation.js';
import { homeRoutes } from './home.js';
import { newRoutes } from './new.js';
import { profilesRoutes } from './profiles.js';
import { pushRoutes } from './push.js';
import type { Route } from './router.js';

/** Each screen package adds routes to its own module, so packages never edit this table. */
export const v2Routes: readonly Route[] = [
  ...foundationRoutes,
  ...homeRoutes,
  ...newRoutes,
  ...pushRoutes,
  ...profilesRoutes,
  ...adminRoutes,
];
