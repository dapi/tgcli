const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function resolveServiceIdentity(accountId = 'default') {
  const normalized = String(accountId ?? 'default').trim().toLowerCase();
  if (normalized !== 'default' && !ACCOUNT_ID_PATTERN.test(normalized)) {
    throw new Error('Account ID is unsafe for service names.');
  }
  if (normalized === 'default') {
    return {
      accountId: 'default',
      launchdLabel: 'com.dapi.tgcli',
      systemdServiceName: 'tgcli',
      logBasename: 'tgcli',
    };
  }
  return {
    accountId: normalized,
    launchdLabel: `com.dapi.tgcli.${normalized}`,
    systemdServiceName: `tgcli-${normalized}`,
    logBasename: `tgcli.${normalized}`,
  };
}
