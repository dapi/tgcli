---
status: draft
date: 2026-09-29
decision-makers: [Danil]
consulted: []
informed: []
---

# Coordinate CLI and Server Access to One Store

## Context and Problem Statement

`tgcli server` and a separate `tgcli` process can open the same account store at once. The server currently creates the Telegram client and archive service without taking the store lock. CLI read commands also create those services: archive initialization can change the schema, and `MessageSyncService.shutdown()` changes every `in_progress` job to `pending`. The current lock protocol therefore neither protects the running server nor makes a CLI read free of side effects. There is no evidence here of actual database corruption; the job-state interference follows from the code paths.

How can the CLI continue to read the local archive while the server is running, even with `mcp.enabled=false`, and still perform live Telegram operations and mutations without a second process owning the same session or archive writer state?

## Decision Drivers

1. An archive read must work independently of the server's health, Telegram connectivity, and the optional MCP endpoint, provided the local archive is healthy.
2. At most one process per account store may own the writable archive service and MTProto session at a time.
3. The existing CLI commands must remain available when the server runs; commands that need the owner must reach it without requiring MCP.
4. Concurrent callers must not reset another caller's sync jobs or accidentally turn an archive request into a live Telegram request.
5. The design should keep local access private, preserve account isolation, and work on the project's macOS and Linux service paths.

## Considered Options

* **Keep the current independent processes and locks.** Rely on SQLite WAL and the existing `LOCK`/`LOCK.read.*` files.
* **Route every CLI command through the server.** Add a private local API and require it for all store-backed reads and changes while the server is running.
* **Separate archive reads from owner operations.** Give the CLI a dedicated read-only archive path; route live reads and changes to the store owner through a private local API.

## Decision Outcome

Chosen option: **Separate archive reads from owner operations.** The archive is a read model that SQLite can serve to concurrent local readers in WAL mode. The Telegram session, schema migrations, sync jobs, and other store changes belong to one owner process. This distinction lets archive reads survive a stopped or unhealthy server while keeping session use and writes in one place. A private CLI API is required regardless of whether MCP is enabled; MCP remains an optional client interface, not the CLI's control channel.

The implementation contract is:

1. `tgcli server` acquires the per-store owner lock **before** opening the Telegram session or writable archive service, holds it for its lifetime, and releases it after shutdown. A standalone CLI operation needing ownership acquires the same lock before creating those services. A second owner must fail or wait; it must never bypass a live owner.
2. The server exposes a per-store Unix domain socket (for example, `cli.sock` inside the store, accessible only to its owner) for typed, versioned CLI operations on macOS and Linux. The CLI connects to the existing owner for live reads, `--source both`, sync-job changes, sends, metadata refreshes, logout, and other commands that use the session or write the store. Commands execute against the server's existing services. Configuration changes that require a restart report that requirement after being coordinated with the owner. Neither an MCP session nor `mcp.enabled=true` is required. Do not forward arbitrary shell commands or expose this endpoint on a network interface.
3. Archive-only reads use a separate SQLite connection opened read-only against `messages.db`. That path does not construct `TelegramClient` or `MessageSyncService`, run schema initialization, modify jobs, or take the owner lock. It uses bounded SQLite busy retries and short read transactions. It can read while the owner writes; it does not read `session.json`.
4. `--source archive` means archive only, including an empty result. Remove the current implicit live fallback for this source. `--source live` and `--source both` explicitly require the owner; if no server owns the store, the CLI can become a short-lived owner for the operation. Preserve the existing output format and account selection.
5. On a live owner lock, the CLI connects to IPC and verifies that the endpoint belongs to the selected store and speaks a compatible protocol. During startup or shutdown it may retry briefly. If the owner remains alive but unreachable, live or mutating commands fail with a clear service error and do not open a second session. Archive-only reads still use SQLite. If no owner exists, standalone ownership is allowed.
6. Keep CLI parsing and output rendering shared across execution modes. Move domain operations to shared functions so the IPC route and standalone route implement the same capability set. Service lifecycle commands remain local; a second `sync --follow` does not start another worker for a store already owned by the server.

| Operation | Server owns store | No owner | Owner alive, IPC unavailable |
| --- | --- | --- | --- |
| Archive-only read | Direct read-only SQLite | Direct read-only SQLite | Direct read-only SQLite |
| Live or combined read | Owner IPC | CLI takes owner lock | Clear service error |
| Store mutation | Owner IPC | CLI takes owner lock | Clear service error |

The routing applies per selected account store. CLI commands that only inspect process or service state do not need an archive or Telegram owner.

### Consequences

* Good: CLI archive searches and message reads remain available during server operation, MCP disablement, and Telegram outages.
* Good: live CLI requests and mutations share the server's session and sync state; multiple CLI callers can address one owner without opening duplicate writable services.
* Good: `--source archive` has a stable, testable meaning and no surprise network access.
* Bad: the CLI needs a read-only archive access layer and a versioned private IPC protocol. Existing command handlers must be refactored rather than merely adding a lock around the server.
* Bad: archive reads can still briefly encounter `SQLITE_BUSY`; long readers can delay WAL checkpointing. Bound retries and transaction lifetime, and report storage failures distinctly from server failures.
* Bad: users who relied on the current implicit live fallback after an empty archive result must request `--source live` or `--source both` explicitly.
* Neutral: an unavailable Telegram connection still prevents live reads; a damaged or inaccessible archive still prevents archive reads. The guarantee concerns process coexistence, not recovery from every external failure.

### Confirmation

* With `mcp.enabled=false`, run one server and concurrent CLI archive reads, live reads, and a sync or mutation; confirm that only the server opens a writable archive service and Telegram session.
* While a server job is `in_progress`, run archive-only CLI queries and confirm its job status and progress are unchanged by those queries.
* Stop or make the owner IPC unavailable while preserving a healthy WAL archive; archive-only reads must still work, while live and mutating commands must report the unavailable owner without opening a second session.
* Verify empty `--source archive` results stay empty and do not call Telegram. Verify `--source live` and `--source both` work through IPC and in standalone mode.
* Exercise startup/shutdown races, concurrent CLI writers, stale locks, account isolation, IPC permissions, and protocol-version mismatch. Update `SKILL.md` and CLI documentation when the source behavior or interface changes.

## Pros and Cons of the Options

### Keep the current independent processes and locks

* Good: no new protocol or command refactor.
* Bad: the server does not currently participate in the lock protocol.
* Bad: read commands instantiate a writable archive service and their shutdown can reset the server's active jobs.
* Bad: SQLite WAL coordinates database pages, not application ownership of sync jobs or the MTProto session. This option fails the single-owner requirement even if database writes serialize.

### Route every CLI command through the server

* Good: one process handles every store operation and can reuse existing services.
* Good: a single route simplifies command parity when the server is healthy.
* Bad: archive reads become unavailable when the server hangs, crashes, or cannot initialize Telegram, contrary to the first driver.
* Bad: the CLI still needs a separate standalone path when the server is not running; routing all reads through IPC does not eliminate that path.

### Separate archive reads from owner operations

* Good: archive reads do not depend on the server or Telegram and can coexist with one SQLite writer.
* Good: IPC is limited to operations that genuinely need the owner, while preserving CLI access to live features when MCP is disabled.
* Bad: archive queries need a separate read-only layer and semantic parity checks with the server's archive queries.
* Bad: combined archive/live requests and command routing need explicit boundaries and tests.

## More Information

FPF separates the **archive read model** from the **account owner** and makes their bridge explicit. “Read” is not one uniform operation: `--source archive` reads local SQLite data, while `--source live` uses Telegram and may change session state; `--source both` crosses both boundaries. The observed code paths establish the current interference; the read-only layer plus private IPC is the proposed explanation of how to remove it. The confirmation cases are predictions to test during implementation, not claims that the design has already been validated.

Code evidence: [`mcp-server.js`](../../mcp-server.js) currently notes the missing server lock; [`core/services.js`](../../core/services.js) constructs both services together; [`message-sync-service.js`](../../message-sync-service.js) initializes the schema and resets active jobs on shutdown; [`cli.js`](../../cli.js) creates those services for reads and falls back from an empty archive result to live Telegram; [`store-lock.js`](../../store-lock.js) defines the current lock protocol. No prior ADR existed under `docs/adrs/` when this draft was written.

SQLite documents that [WAL permits readers and a writer to proceed concurrently](https://www.sqlite.org/wal.html), while also describing exceptional `SQLITE_BUSY` cases and checkpoint effects. That database property supports a dedicated read-only connection; it does not make the current application-level read path safe.
