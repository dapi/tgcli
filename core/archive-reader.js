import Database from 'better-sqlite3';
import path from 'path';

import { ArchiveQueries } from './archive-queries.js';
import { assertVerifiedAccountMetadata, isNamedAccountStore } from './accounts.js';
import { resolveStorePaths } from './store.js';

export class ArchiveUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ArchiveUnavailableError';
  }
}

export class ArchiveReader extends ArchiveQueries {
  constructor(storeDir, options = {}) {
    super();
    const resolvedStoreDir = path.resolve(storeDir);
    if (isNamedAccountStore(resolvedStoreDir)) {
      assertVerifiedAccountMetadata(resolvedStoreDir);
    }

    this.dbPath = options.dbPath ?? resolveStorePaths(resolvedStoreDir).dbPath;
    this.processing = false;
    try {
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma('busy_timeout = 2000');
      this.listContactTagsStmt = this.db.prepare(`
        SELECT tag FROM contact_tags WHERE user_id = ? ORDER BY tag ASC
      `);
    } catch (error) {
      this.db?.close();
      if (error?.code === 'SQLITE_CANTOPEN') {
        throw new ArchiveUnavailableError('Archive is not initialized. Run `tgcli sync --once`.', { cause: error });
      }
      throw new ArchiveUnavailableError(`Archive cannot be opened for reading: ${error.message}`, { cause: error });
    }
  }

  close() {
    if (this.db?.open) {
      this.db.close();
    }
  }

  getArchivedMessageContext(options) {
    return this.db.transaction(() => super.getArchivedMessageContext(options))();
  }

  getContact(userId) {
    return this.db.transaction(() => super.getContact(userId))();
  }
}
