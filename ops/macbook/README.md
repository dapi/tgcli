# MacBook service

The MacBook runs `com.dapi.tgcli` as a user LaunchAgent. Its source plist is
`~/code/tgcli/ops/macbook/com.dapi.tgcli.plist`; the desired state is registered
in `~/code/personal-ops/launchd/macbook-registry.json`. It uses the MacBook's
existing Telegram store and serves MCP only on the configured loopback address.

Install the matching CLI through `~/dotfiles`, then run
`~/code/tgcli/scripts/install-macbook-launchagent.sh`. Verify with
`~/code/personal-ops/scripts/personalctl launchd status` and `plan`.

Rollback: run `tgcli service stop`, then remove the installed plist and restore
the MacBook registry to `desired_state: absent`. Keep the store intact.
