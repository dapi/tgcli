import fs from 'node:fs';

const event = () => ({ add() {}, remove() {} });

export const normalizeChannelId = (id) => id;
export const summarizeMedia = () => null;

export default class MockTelegramClient {
  constructor() {
    this.dialogCalls = 0;
    this.client = { onNewMessage: event(), onEditMessage: event(), onDeleteMessage: event() };
    if (process.env.TGCLI_MOCK_CONSTRUCTED_FILE) {
      fs.writeFileSync(process.env.TGCLI_MOCK_CONSTRUCTED_FILE, String(process.pid));
    }
  }

  async initializeDialogCache() { return true; }
  async listDialogs() {
    this.dialogCalls += 1;
    if (process.env.TGCLI_MOCK_DIALOG_FLOOD) throw new Error('FLOOD_WAIT_23');
    if (process.env.TGCLI_MOCK_DIALOG_FLOOD_ONCE && this.dialogCalls === 1) {
      throw new Error('FLOOD_WAIT_23');
    }
    return [{ id: 42, title: 'Fixture channel', type: 'channel' }];
  }
  async searchDialogs() { return [{ id: 42, title: 'Fixture channel', type: 'channel' }]; }
  async listGroups() { return [{ id: 7, title: 'Fixture group' }]; }
  async isAuthorized() { return true; }
  async ensureLogin() {}
  async startUpdates() {}
  onChannelTooLong() { return () => {}; }
  async destroy() {}
}
