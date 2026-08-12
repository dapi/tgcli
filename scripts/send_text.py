#!/usr/bin/env python3
"""Send Telegram text read from stdin without shell escaping."""

from __future__ import annotations

import argparse
import subprocess
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Send stdin as a Telegram message through tgcli."
    )
    parser.add_argument("--to", required=True, help="Chat ID or @username")
    parser.add_argument("--topic", help="Forum topic ID")
    parser.add_argument("--reply-to", help="Message ID to reply to")
    parser.add_argument("--parse-mode", choices=("markdown", "html", "none"))
    parser.add_argument("--timeout", default="30s")
    parser.add_argument("--retries", type=int)
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--no-preview", action="store_true")
    parser.add_argument("--no-forwards", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    message = sys.stdin.read()
    if message.endswith("\n"):
        message = message[:-1]
    if not message:
        print("send_text.py: stdin message is empty", file=sys.stderr)
        return 2

    command = [
        "tgcli",
        "send",
        "text",
        "--to",
        args.to,
        "--message",
        message,
        "--json",
        "--timeout",
        args.timeout,
    ]
    for flag, value in (
        ("--topic", args.topic),
        ("--reply-to", args.reply_to),
        ("--parse-mode", args.parse_mode),
        ("--retries", args.retries),
    ):
        if value is not None:
            command.extend((flag, str(value)))
    for flag, enabled in (
        ("--silent", args.silent),
        ("--no-preview", args.no_preview),
        ("--no-forwards", args.no_forwards),
    ):
        if enabled:
            command.append(flag)

    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
