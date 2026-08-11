"""The execution zone's guest agent: one connection, one command.

systemd socket-activates this per connection with the AF_VSOCK socket as both stdin and stdout,
so there is no listener, no multiplexing and no state here. The protocol is one JSON request
line in, newline-delimited JSON frames out:

    in   {"command": "...", "cwd": "/workspace", "env": {}, "timeoutMs": 120000,
          "refresh": false, "stdin": "<base64>"}
    out  {"t": "o", "d": "<base64>"}   stdout
         {"t": "e", "d": "<base64>"}   stderr
         {"t": "x", "code": 0, "timedOut": false, "aborted": false}

Output is base64 because a command's output is bytes, not text, and the host hands it to pi's
bash tool as a Buffer.
"""

import base64
import json
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time

CHUNK = 64 * 1024
# How long output may stay quiet after the command itself has exited before we stop waiting on
# pipes a background child inherited. Without it, `some-server &` would hang the call.
QUIET_AFTER_EXIT = 0.25
KILL_GRACE = 2.0


def send(sock, frame):
    sock.sendall((json.dumps(frame) + "\n").encode("utf-8"))


def send_bytes(sock, kind, data):
    send(sock, {"t": kind, "d": base64.b64encode(data).decode("ascii")})


def read_request(sock):
    buf = bytearray()
    while b"\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf.extend(chunk)
    line = bytes(buf).split(b"\n", 1)[0]
    if not line.strip():
        return None
    return json.loads(line.decode("utf-8"))


def refresh_workspace(sock):
    """Re-read a lower layer the write zone changed while we were up."""
    ctl = os.environ.get("PAPER_ZONE_CTL")
    if not ctl:
        return
    done = subprocess.run([ctl, "remount"], capture_output=True)
    if done.returncode != 0 and done.stderr:
        send_bytes(sock, "e", done.stderr)


def build_env(request):
    env = {
        "PATH": os.environ.get("PAPER_ZONE_PATH", "/run/current-system/sw/bin"),
        "HOME": "/root",
        "TMPDIR": "/tmp",
        "TERM": "dumb",
        "LANG": "C.UTF-8",
    }
    for name, value in (request.get("env") or {}).items():
        env[str(name)] = str(value)
    return env


def feed_stdin(proc, data):
    try:
        proc.stdin.write(data)
        proc.stdin.close()
    except (BrokenPipeError, ValueError, OSError):
        pass


def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.monotonic() + KILL_GRACE
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.05)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass


def pump(sock, proc, deadline):
    """Forward output until the command is done, the host hangs up, or the deadline passes.

    Returns (timed_out, hung_up).
    """
    streams = {proc.stdout.fileno(): "o", proc.stderr.fileno(): "e"}
    open_fds = set(streams)
    exited_at = None

    while open_fds:
        wait = 0.1
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return True, False
            wait = min(wait, remaining)

        ready, _, _ = select.select(list(open_fds) + [sock.fileno()], [], [], wait)

        if sock.fileno() in ready and not sock.recv(4096):
            # The host writes exactly one line and then stays silent, so anything readable here
            # is the connection closing: the call was cancelled.
            return False, True

        for fd in ready:
            if fd == sock.fileno():
                continue
            data = os.read(fd, CHUNK)
            if not data:
                open_fds.discard(fd)
                continue
            send_bytes(sock, streams[fd], data)

        if proc.poll() is None:
            exited_at = None
        elif exited_at is None:
            exited_at = time.monotonic()
        elif not ready and time.monotonic() - exited_at > QUIET_AFTER_EXIT:
            break

    return False, False


def main():
    # Accept=yes hands us the connection itself on fd 0; fd 1 is the same socket.
    sock = socket.socket(fileno=0)
    sock.setblocking(True)

    try:
        request = read_request(sock)
    except ValueError as error:
        send(sock, {"t": "e", "d": base64.b64encode(str(error).encode()).decode("ascii")})
        send(sock, {"t": "x", "code": 127, "timedOut": False, "aborted": False})
        return 0

    if request is None:
        # A probe connection, used by the host to decide the VM has finished booting.
        send(sock, {"t": "x", "code": 0, "timedOut": False, "aborted": False})
        return 0

    if request.get("refresh"):
        refresh_workspace(sock)

    cwd = request.get("cwd") or "/workspace"
    if not os.path.isdir(cwd):
        cwd = "/workspace"

    timeout_ms = request.get("timeoutMs") or 0
    deadline = time.monotonic() + timeout_ms / 1000.0 if timeout_ms > 0 else None

    stdin_data = request.get("stdin")
    proc = subprocess.Popen(
        [os.environ.get("PAPER_ZONE_SHELL", "/bin/sh"), "-c", request.get("command", "")],
        cwd=cwd,
        env=build_env(request),
        stdin=subprocess.PIPE if stdin_data else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        # Its own process group, so a timeout or a cancellation takes the whole tree with it.
        start_new_session=True,
    )

    if stdin_data:
        # On a thread, so a command that talks back while we are still feeding it cannot
        # deadlock against the pipe buffer.
        feeder = threading.Thread(
            target=feed_stdin, args=(proc, base64.b64decode(stdin_data)), daemon=True
        )
        feeder.start()

    try:
        timed_out, hung_up = pump(sock, proc, deadline)
    except (BrokenPipeError, ConnectionResetError):
        timed_out, hung_up = False, True

    code = proc.poll()
    if code is None and not (timed_out or hung_up):
        # Both pipes closed but the command is still alive. Give it the rest of its deadline
        # rather than waiting forever on something that closed its own stdout.
        remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
        try:
            code = proc.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            timed_out = True

    if timed_out or hung_up:
        # Only here. On a clean exit anything the command left running is left alone, so a
        # background server started in one bash call is still there in the next one.
        kill_group(proc)
        code = proc.wait()

    if not hung_up:
        try:
            send(sock, {"t": "x", "code": code, "timedOut": timed_out, "aborted": False})
        except (BrokenPipeError, ConnectionResetError):
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
