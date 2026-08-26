import { describe, expect, it } from 'vitest';

import { resolveServiceIdentity } from '../core/service-identity.js';

describe('per-account service identity', () => {
  it('preserves legacy service names for the default account', () => {
    expect(resolveServiceIdentity('default')).toEqual({
      accountId: 'default',
      launchdLabel: 'com.dapi.tgcli',
      systemdServiceName: 'tgcli',
      logBasename: 'tgcli',
    });
  });

  it('uses collision-free service and log names for named accounts', () => {
    expect(resolveServiceIdentity('work')).toEqual({
      accountId: 'work',
      launchdLabel: 'com.dapi.tgcli.work',
      systemdServiceName: 'tgcli-work',
      logBasename: 'tgcli.work',
    });
  });

  it('rejects unsafe account ids in service names', () => {
    expect(() => resolveServiceIdentity('../work')).toThrow(/account id/i);
  });
});
