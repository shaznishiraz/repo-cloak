import { signal } from '@preact/signals';
import type { Overview, SessionInfo } from '../api/contracts.js';

export const sessionInfo = signal<SessionInfo | null>(null);
export const overview = signal<Overview | null>(null);
export const loadError = signal<string | null>(null);
