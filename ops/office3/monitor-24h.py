#!/usr/bin/env python3
"""Record read-only office3 tgcli service health for one day."""

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from datetime import datetime, timedelta, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def probe(port):
    tgcli = str(Path.home() / ".local/bin/tgcli")
    command = [tgcli, "service", "status", "--json"]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=True)
        service = json.loads(result.stdout)
        running = service.get("running") is True
        pid = service.get("pid")
        version = service.get("cliVersion")
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        running, pid, version = False, None, None

    try:
        result = subprocess.run(
            [tgcli, "sync", "status", "--json"],
            capture_output=True, text=True, timeout=20, check=True,
        )
        sync_status = json.loads(result.stdout)
        ipc_ready = isinstance(sync_status, dict)
        dialog_refresh_deferred = sync_status.get("dialogRefreshDeferred") is True
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        ipc_ready, dialog_refresh_deferred = False, None

    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            mcp_listening = True
    except OSError:
        mcp_listening = False

    return {
        "at": utc_now(),
        "healthy": running and ipc_ready and mcp_listening and version == "2.9.0"
        and not dialog_refresh_deferred,
        "running": running,
        "pid": pid,
        "cliVersion": version,
        "mcpListening": mcp_listening,
        "ipcReady": ipc_ready,
        "dialogRefreshDeferred": dialog_refresh_deferred,
    }


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as file:
        json.dump(value, file, indent=2)
        file.write("\n")
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--duration", type=int, default=86400)
    parser.add_argument("--interval", type=int, default=300)
    args = parser.parse_args()
    if args.duration <= 0 or args.interval <= 0 or not 1 <= args.port <= 65535:
        parser.error("port, duration and interval must be positive")
    if socket.gethostname() != "Danils-iMac-Home":
        parser.error("this monitor is only for office3")

    log_dir = Path(__file__).resolve().parents[2] / "log"
    log_dir.mkdir(mode=0o700, exist_ok=True)
    samples_path = log_dir / "office3-monitor-2.9.0.jsonl"
    summary_path = log_dir / "office3-monitor-2.9.0-summary.json"
    samples = os.open(samples_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.chmod(samples_path, 0o600)

    started_time = datetime.now(timezone.utc)
    started = started_time.isoformat(timespec="seconds")
    scheduled_end = (started_time + timedelta(seconds=args.duration)).isoformat(timespec="seconds")
    deadline = time.monotonic() + args.duration
    count = 0
    failures = 0
    pid_changes = 0
    previous_pid = None
    try:
        while True:
            sample = probe(args.port)
            count += 1
            failures += not sample["healthy"]
            if previous_pid is not None and sample["pid"] != previous_pid:
                pid_changes += 1
            previous_pid = sample["pid"]
            os.write(samples, (json.dumps(sample) + "\n").encode())
            completed = time.monotonic() >= deadline
            write_json(summary_path, {
                "startedAt": started,
                "scheduledEndAt": scheduled_end,
                "lastSampleAt": sample["at"],
                "completed": completed,
                "samples": count,
                "unhealthySamples": failures,
                "pidChanges": pid_changes,
                "latest": sample,
            })
            if completed:
                break
            time.sleep(min(args.interval, max(0, deadline - time.monotonic())))
    finally:
        os.close(samples)


if __name__ == "__main__":
    main()
