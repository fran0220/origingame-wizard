"""Runs a command in a real pseudo-terminal and answers its prompts in order.

Input (argv[1], a JSON file): {"argv": [...], "env": {...}, "cwd": "...",
"steps": [{"expect": "<regex>", "send": "<keys>"}], "timeoutSeconds": 60}.
Each step waits until its regex matches the terminal output (ANSI codes
removed) after the previous match, then types its keys. Output (stdout, JSON):
{"code": <exit status or null>, "transcript": "...", "answered": <steps done>,
"error": "<why it stopped early>" | null}.
"""
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import time
import fcntl
import termios

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[=>78]|\r")


def main():
    spec = json.load(open(sys.argv[1]))
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(spec.get("cwd") or ".")
        os.execvpe(spec["argv"][0], spec["argv"], spec["env"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    deadline = time.time() + spec.get("timeoutSeconds", 60)
    raw = b""
    position = 0
    answered = 0
    code = None
    error = None
    steps = spec["steps"]

    def clean():
        return ANSI.sub("", raw.decode("utf-8", "replace"))

    while True:
        if time.time() > deadline:
            error = f"timed out waiting for step {answered + 1}: {steps[answered]['expect'] if answered < len(steps) else 'exit'}"
            os.kill(pid, signal.SIGKILL)
            break
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                break
            raw += chunk
        if answered < len(steps):
            match = re.compile(steps[answered]["expect"]).search(clean(), position)
            if match:
                position = match.end()
                time.sleep(0.25)  # let the prompt finish drawing and start reading keys
                for key in steps[answered]["send"]:
                    os.write(fd, key.encode())
                    time.sleep(0.03)
                answered += 1
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            # Drain what is left, then stop.
            while True:
                ready, _, _ = select.select([fd], [], [], 0.2)
                if not ready:
                    break
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                raw += chunk
            code = os.waitstatus_to_exitcode(status)
            break
    if code is None:
        try:
            _, status = os.waitpid(pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            pass
    if error is None and answered < len(steps):
        error = f"exited before step {answered + 1}: {steps[answered]['expect']}"
    json.dump({"code": code, "transcript": clean(), "answered": answered, "error": error}, sys.stdout)


main()
