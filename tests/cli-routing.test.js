import { expect, it } from 'vitest';

import { buildProgram, classifyCliRoute } from '../cli.js';

it('classifies every runnable CLI command for store ownership', () => {
  const commands = [];
  function visit(parent, prefix = []) {
    for (const command of parent.commands) {
      const parts = [...prefix, command.name()];
      if (command._actionHandler) commands.push(parts.join(' '));
      visit(command, parts);
    }
  }
  visit(buildProgram());
  expect(commands.length).toBeGreaterThan(50);
  expect(commands.filter((name) => classifyCliRoute(name) === null)).toEqual([]);
});
