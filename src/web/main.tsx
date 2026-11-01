import './tokens.css';
import { render } from 'preact';
import { readSession } from './api/session.js';

const session = readSession(location.hash, sessionStorage);
history.replaceState(null, '', `/${session.route}`);
const root = document.getElementById('app');
if (root) render(<p>repo-cloak</p>, root);
