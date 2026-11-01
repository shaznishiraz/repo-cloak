import { render } from 'preact';
import './tokens.css';
import { readSession } from './api/session.js';
import { startAutoLock } from './screens/settings/auto-lock.js';
import { startSession } from './shell/load.js';
import { registerShellCommands } from './shell/nav-commands.js';
import { startRouter } from './shell/router.js';
import { Shell } from './shell/shell.js';

const session = readSession(location.hash, sessionStorage);
history.replaceState(null, '', `/${session.route}`);
startRouter();
registerShellCommands();
startSession(session);
startAutoLock();
const root = document.getElementById('app');
if (root) render(<Shell />, root);
