import { expect, it } from 'vitest';
import { addAgentGuidance, stripAgentGuidance } from '../../src/core/agent-guidance.js';

it('preserves exact user instructions through a managed guidance round trip', () => {
  for (const text of ['', '# Project\n', '# Project\r\n\r\n']) {
    const decorated = addAgentGuidance(text);
    expect(decorated).toContain('cloak_request_files');
    expect(stripAgentGuidance(decorated)).toBe(text);
    expect(() => addAgentGuidance(decorated)).toThrow(/managed/);
    expect(() => stripAgentGuidance(decorated.replace('cloak_request_files', 'changed'))).toThrow(
      /changed/,
    );
  }
});
