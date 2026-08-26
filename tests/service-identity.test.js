import { describe, expect, it } from 'vitest';

import { parseLaunchdList, resolveServiceIdentity } from '../core/service-identity.js';

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

  it('matches launchd status by exact label instead of default-label prefix', () => {
    const output = [
      '4321\t0\tcom.dapi.tgcli.work',
      '-\t0\tcom.dapi.tgcli.family',
    ].join('\n');

    expect(parseLaunchdList(output, 'com.dapi.tgcli')).toBeNull();
    expect(parseLaunchdList(output, 'com.dapi.tgcli.work')).toEqual({
      pid: 4321,
      running: true,
      status: 'started',
    });
  });
});
