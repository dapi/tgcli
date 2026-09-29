# CLI and server access to one account store

**Status:** Draft implementation specification

**Decision:** [ADR 0001](../adrs/0001-coordinate-cli-and-server-store-access.md)

**Scope:** Local `tgcli` processes sharing one selected account store on macOS or Linux.

## Required behavior

For each account store, exactly one process owns the writable `messages.db` service and MTProto `session.json` at a time. That process may be `tgcli server` or a standalone CLI command. A healthy archive remains readable from another CLI process while an owner is running, even when Telegram or owner IPC is unavailable. Owner-dependent commands retain their CLI arguments and output whether they execute in the local process or through the owner. `mcp.enabled` has no effect on CLI routing.

An archive read is a local SQLite query without Telegram access or database writes. A live read may update the Telegram session and cached state. A command's name or `acquireReadLock()` call does not prove it is archive-only.

## Ownership and routing

An exclusive transaction on a per-store SQLite guard database is the lifetime ownership claim. `LOCK` publishes a random owner instance ID, PID, owner kind (`server`, `sync`, `auth`, or `transient`), protocol version, and readiness state (`starting`, `ready`, `stopping`, or `transient`). A ready serviceable owner also advertises its local IPC address. Treat malformed or partly written metadata as startup in progress and retry within the caller's deadline. Use the canonical store path and account identity when comparing owners; `service-state.json` is diagnostic, not proof of ownership. Release only the caller's own claim. A guard transaction ends automatically on process death; while holding a new guard, reclaim stale `LOCK` metadata only when its process is proven dead. An inaccessible or ambiguous process is not proof of death. Test concurrent claim and crash-recovery races.

`tgcli server`, `sync --follow` (including default `sync`), `sync --once`, and `auth --follow` are **serviceable owners**: after their services are ready, they serve the same private CLI IPC. During login or initialization they remain in `starting` and other owner-dependent callers wait; archive reads proceed. `sync --once` drains accepted IPC requests before exiting. A serviceable owner closes IPC, finishes accepted operations, closes Telegram and the writable archive service, then releases `LOCK`.

Ordinary one-shot CLI commands are **transient owners**. If the store has no owner, a command needing Telegram or a store write atomically claims `LOCK`, creates its services, executes locally, closes them, and releases the claim in `finally`. A second owner-dependent CLI command waits for a transient owner to finish; ownership discovery waits at most 30 seconds by default, or up to the remaining `--timeout` when set. It does not try IPC or open another session. A server starting during a transient command follows the same wait-or-busy rule. A standalone command must never require an IPC server to do its own work.

If a ready serviceable owner holds the lock, the CLI uses IPC. It verifies the owner instance ID, canonical store identity, and protocol version in the handshake. A ready owner with unreachable IPC is an error for owner-dependent commands; the CLI must not take over its session. Archive-only reads still work. If the owner dies, stale-claim recovery runs before a new owner starts. Startup and shutdown transitions use bounded retries, not a blind fallback to another session.

On macOS/Linux, IPC uses a Unix domain socket in an owner-only runtime directory: `~/Library/Application Support/tgcli/run` on macOS and `${XDG_STATE_HOME:-~/.local/state}/tgcli/run` on Linux. The socket name is a short hash of the canonical store path, so custom stores and named accounts get separate endpoints without hitting socket-path length limits. Set the directory to `0700` and socket to `0600`; the endpoint exists independently of the optional MCP HTTP listener. Remove an old socket only after proving its owner dead. Other platform transports require an equivalent local-only endpoint before promising concurrent owner-dependent commands there.

## Command routing

Routes below apply after `--account` selects the store. `A` means direct read-only archive access in the calling CLI process; `O` means execute on the current owner over IPC or claim transient ownership and execute locally; `C` means a long-running command whose behavior with an existing owner is given in its table row; `L` means local configuration or process control without Telegram or writable archive services; `D` means composed diagnostics. `A→O` means query the archive first, then use `O` only for the existing live fallback on a cache miss.

| Commands | Route | Required detail |
| --- | --- | --- |
| `--help`, `--version`; `accounts list/add`; `config list/get` | L | Account registry changes retain their separate registry lock. Reads of config do not construct services. |
| `config set/unset` | O | Serialize writes with the owner; report when a running owner needs restart to use changed settings. |
| `auth` (login options), `auth status`, `auth logout` | O | An existing ready owner answers `auth` from its current session and handles logout. Without an owner, login prompts remain in the standalone CLI under its owner lock. `auth --follow` becomes `C` after login. Auth challenges and responses must use typed IPC messages if login is later delegated to an existing owner; they are never logged. |
| `sync --follow`, default `sync`, `sync --once` | C | With an existing server or follow owner, follow reports the active realtime sync; once requests work and waits for idle or timeout. With a `sync --once` owner, follow waits for it to finish, then claims ownership. Without an owner, own the store and expose IPC while running. |
| `sync status`; `doctor` | D | Prefer owner IPC for current process state. With no owner, show archive counters and `processing=false`; with an unreachable owner, show archive counters and mark live/process fields unknown. `doctor --connect` needs `O`. Diagnostics never instantiate a writable service just to read counters. |
| `sync jobs list` | A | Read persisted jobs without changing their state. |
| `sync jobs add/retry/cancel`; `channels sync` | O | Job mutations and channel sync settings run in the owner. |
| `server`; `service install/start/stop/status/logs` | L/C | Server start is `C`: it claims ownership if free and waits or reports busy if another owner exists. Service commands control or inspect the process manager locally. The started server itself claims ownership before creating services. |
| `owner request <requestId>` | L | Query the active owner's recent in-memory outcome after `UNKNOWN_RESULT`; never create a new owner for this diagnostic. |
| `channels list` | O | Lists live Telegram dialogs. |
| `channels show` | A→O | Cached channel first; preserve its existing live lookup on a cache miss. |
| `messages list/search/show/context --source archive` (also the default source) | A | Empty/not-found archive results do not invoke Telegram. |
| `messages list/search/show/context --source live` or `--source both` | O | Live or combined query uses the owner; keep current result shape and merge behavior. |
| `send text/photo/file`; `media download` | O | Normalize file input/output paths in the calling CLI before IPC so the owner's working directory cannot change their meaning. |
| `topics list/search` | O | These fetch Telegram topics and currently upsert them into the archive. |
| `tags list/search` | A | Query cached tags only. |
| `tags set/auto`; `metadata refresh` | O | These change archive data and may call Telegram. |
| `metadata get` | A→O | Cached metadata first, existing live lookup on a miss. |
| `contacts show` | A→O | Cached contact first, existing live refresh on a miss. |
| `contacts search`; `contacts alias set/rm`; `contacts tags add/rm`; `contacts notes set` | O | Search currently refreshes contacts before querying; all listed writes need the owner. |
| `groups list/info/requests list/invite get`; `folders list/show` | O | These are Telegram reads, even where the old code used a read lock. |
| `groups requests approve/decline`, `groups rename/members add/remove/invite edit/revoke/join/leave`; `folders create/edit/delete/reorder/chats add/remove/join` | O | Telegram mutations use the same owner and normal CLI result formatting. |

For `A→O`, a cache miss with a live but unreachable owner produces a specific “not in archive; owner unavailable” error. It does not silently return stale data or start a second session. If there is no owner, the fallback claims transient ownership. `--source archive` is strict for all four message commands; this intentionally removes the current implicit live fallback and requires `SKILL.md` and CLI documentation changes.

## Archive reader

Extract archive SQL queries into shared query functions used by both the writable service and a dedicated reader. Open `messages.db` with `better-sqlite3` in read-only, file-must-exist mode, set a bounded busy timeout, and keep transactions short. The reader must not call schema creation/migrations, `MessageSyncService.shutdown()`, or any Telegram client constructor. Do not use an immutable SQLite connection against an active WAL archive. Validate named-account store metadata before opening it. A missing archive reports “archive not initialized” with a sync hint; an incompatible schema or persistent `SQLITE_BUSY` reports an archive-specific error. No condition triggers an implicit live fallback for an explicit archive request.

## Owner IPC and concurrency

Protocol version 1 uses length-prefixed JSON frames capped at 1 MiB each. A request carries a UUID request ID, store identity, operation name, typed arguments, and deadline; large results arrive in ordered chunks followed by an explicit completion frame. The owner accepts only an allowlisted set of operations; it does not execute CLI argument strings or shell commands. New operations return domain results for CLI-side rendering. The allowlisted `cli.execute` bridge runs existing handler functions against owner services and returns their rendered stdout/stderr so current commands keep their output during extraction; its command path and arguments are typed JSON, not a shell command. Errors have stable codes for `OWNER_STARTING`, `OWNER_UNAVAILABLE`, `OWNER_BUSY`, `PROTOCOL_MISMATCH`, `ARCHIVE_UNAVAILABLE`, `UNKNOWN_RESULT`, and operation failures. Do not include credentials, session data, or auth challenge values in logs or service-state files. Preserve `--json`, `--account`, and `--timeout` behavior across local and IPC routes.

One owner process does not automatically serialize its internal requests. Keep sync jobs sequential. MCP and CLI IPC use the same `MessageSyncService`; its synchronous SQLite statements and short multi-row transactions commit on one Node event loop without interleaving at an `await`. Do not hold a global mutation mutex across Telegram network waits. A shared coordinator bounds concurrent live operations to four across MCP sessions and CLI IPC. Queued IPC calls whose deadline expires must not start. Once an operation starts, an in-flight Telegram mutation may be impossible to cancel safely: keep it tracked by request ID until it finishes, report `UNKNOWN_RESULT` on timeout, and let the CLI query `owner request <requestId>`. Retain recent outcomes in memory for one hour, capped at 1000 completed records, without storing request arguments or response bodies. After owner restart the outcome may be unknown; inspect Telegram or the archive before retrying a non-idempotent change. Retrying an archive read after connection loss is safe.

## Implementation plan and gates

Each phase is a reviewable commit; continue only after its gate passes.

1. **Freeze behavior and extract queries.** Add tests for current output shapes and the command routing table. Move archive queries behind shared functions; implement the read-only archive connection. Gate: a CLI archive read against a WAL database cannot construct Telegram or the writable service, cannot change an `in_progress` job, and still works while a writer is active.
2. **Establish ownership.** Replace the partial lock protocol with atomic owner claims, identity checks, bounded waiting, and cleanup on startup failure. Acquire the server claim before `createServices()`. Gate: two independent processes cannot both open writable services or the same MTProto session; races and stale claims are covered by process-level tests.
3. **Add one owner runtime and private IPC.** Reuse it in `server`, `sync --once`, `sync --follow`, and `auth --follow`; keep MCP optional. Gate: with `mcp.enabled=false`, two concurrent CLI clients can make owner-dependent requests to a running server or follow process without a second session. IPC identity, permissions, version mismatch, deadlines, outcome inspection, and shutdown are tested.
4. **Migrate all CLI commands.** Use the routing table and shared domain operations, preserving text/JSON output. Normalize media paths; remove implicit archive-to-live fallback and update `SKILL.md`, README, and command help. Gate: every command in the table works both with a ready owner and with no owner, or has the specified local/status behavior; an unreachable live owner never triggers a second session.
5. **Verify integration.** Run unit and multi-process tests, then a controlled manual smoke with the selected account: server with MCP disabled, `sync --follow`, standalone CLI, concurrent archive and live reads, job progress, media paths, and orderly/abrupt shutdown. Avoid creating extra Telegram sessions during the smoke. Gate: observed behavior matches the table and ADR; record results and update ADR status only after Danil reviews the decision.

Implementation tests should use temporary stores and mocked Telegram clients by default. Manual Telegram checks must be narrow enough to avoid unnecessary API calls and rate limits.

## Verification record (2026-09-29)

- Unit and multi-process suite: 331 tests passed after the second review pass. The process tests cover concurrent CLI calls to one owner, read-only archive access during a WAL write, owner identity and protocol checks, socket permissions, stale and competing lock claims, output preservation, and refusal to create a second session when owner IPC is unavailable. A route classification test covers every runnable CLI command. A cleanup regression test verifies that a transient claim is released when service shutdown fails.
- A real-account archive-only `sync status` and `messages list --limit 1` succeeded without taking `LOCK`.
- The controlled real-account server smoke did not reach IPC readiness: Telegram returned `FLOOD_WAIT_22`, then `FLOOD_WAIT_23` on one retry during `refreshChannelsFromDialogs()`. Both attempts released `LOCK`. The live server/CLI integration gate remains unverified until Telegram permits that request; no further retry was made.

## Second review pass (2026-09-29)

- A lifetime SQLite guard transaction now releases ownership on process death. Process tests cover a competing claimant, abandoned legacy `LOCK.reclaim`, and abrupt owner exit. A concurrent old-version process that does not use the guard is rejected through its live `LOCK` metadata; mixed-version races still require caution during rollout.
- A shared coordinator bounds live calls across MCP sessions and CLI IPC without holding a global queue through Telegram waits. Process tests start `mcp-server.js` with a mocked Telegram client and a temporary store: four CLI processes share it with MCP disabled; two MCP clients and one CLI process share it with MCP enabled; concurrent MCP and CLI tag writes both persist.
- IPC now retains bounded in-memory outcome status for accepted requests. A timeout test verifies `requestId`, a running status, and a completed status after the handler finishes. The journal is not durable across owner crashes.
- A real-account `mcp-server.js` launch was attempted once in this pass. It failed during dialog refresh with `FLOOD_WAIT_22`; startup released `LOCK`. No further real Telegram request was made. Real-account IPC readiness and live CLI behavior remain unverified.
