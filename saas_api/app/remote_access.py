from __future__ import annotations

import posixpath
import time
from dataclasses import dataclass
from io import StringIO
from typing import Any

import paramiko


@dataclass(frozen=True)
class HostRef:
    address: str
    port: int
    username: str


@dataclass(frozen=True)
class AuthRef:
    type: str  # password | ssh_key | agent
    password: str | None = None
    private_key: str | None = None
    passphrase: str | None = None


def _sanitize_host(host: dict[str, Any]) -> HostRef:
    address = str(host.get("address") or "").strip()
    if not address:
        raise ValueError("Missing host.address")
    try:
        port = int(host.get("port", 22))
    except Exception:
        port = 22
    if port < 1 or port > 65535:
        raise ValueError("Invalid host.port")
    username = str(host.get("username") or host.get("user") or "").strip()
    if not username:
        raise ValueError("Missing host.username")
    if len(username) > 64:
        raise ValueError("Invalid host.username")
    return HostRef(address=address, port=port, username=username)


def _sanitize_auth(auth: dict[str, Any]) -> AuthRef:
    t = str(auth.get("type") or "").strip()
    if t not in {"password", "ssh_key", "agent"}:
        raise ValueError("Invalid auth.type")
    password = str(auth.get("password") or "") if t == "password" else ""
    private_key = str(auth.get("privateKey") or auth.get("private_key") or "") if t == "ssh_key" else ""
    passphrase = str(auth.get("passphrase") or "") if t == "ssh_key" else ""
    if t == "password":
        if not password:
            raise ValueError("Missing auth.password")
        if len(password) > 4096:
            raise ValueError("Invalid auth.password")
        return AuthRef(type=t, password=password)
    if t == "ssh_key":
        if not private_key:
            raise ValueError("Missing auth.privateKey")
        if len(private_key) > 200_000:
            raise ValueError("Invalid auth.privateKey")
        if passphrase and len(passphrase) > 4096:
            raise ValueError("Invalid auth.passphrase")
        return AuthRef(type=t, private_key=private_key, passphrase=passphrase or None)
    # agent
    return AuthRef(type=t)


def _connect_client(host: HostRef, auth: AuthRef, timeout_sec: float) -> paramiko.SSHClient:
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kw: dict[str, Any] = {
        "hostname": host.address,
        "port": host.port,
        "username": host.username,
        "timeout": timeout_sec,
        "banner_timeout": min(10.0, timeout_sec),
        "auth_timeout": min(15.0, timeout_sec),
        "look_for_keys": False,
        "allow_agent": auth.type == "agent",
    }

    if auth.type == "password":
        kw["password"] = auth.password
    elif auth.type == "ssh_key":
        # Try both RSA and Ed25519; rely on paramiko to parse formats.
        # Note: we keep key only in memory (request-scoped).
        pkey = None
        key_text = auth.private_key or ""
        passphrase = auth.passphrase
        last_err: Exception | None = None
        for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
            try:
                pkey = key_cls.from_private_key(StringIO(key_text), password=passphrase)
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                continue
        if pkey is None:
            raise ValueError(f"Invalid private key: {last_err}") from last_err
        kw["pkey"] = pkey

    cli.connect(**kw)
    return cli


def ssh_connect(
    *,
    host: dict[str, Any],
    auth: dict[str, Any],
    timeout_sec: float,
) -> tuple[paramiko.SSHClient, dict[str, Any]]:
    """
    Establish an SSH connection and return (client, info).
    NOTE: does NOT persist any secrets; caller decides how to store the client.
    """
    h = _sanitize_host(host)
    a = _sanitize_auth(auth)
    cli = _connect_client(h, a, timeout_sec=timeout_sec)
    info = {"address": h.address, "port": h.port, "username": h.username}
    return cli, info


def ssh_exec_on_client(
    *,
    client: paramiko.SSHClient,
    command: str,
    cwd: str | None,
    timeout_sec: float,
    max_stdout_bytes: int = 200_000,
    max_stderr_bytes: int = 200_000,
) -> dict[str, Any]:
    """
    Exec on an existing SSHClient (session-based).
    """
    cmd = str(command or "").strip()
    if not cmd:
        raise ValueError("Missing command")
    if len(cmd) > 16_000:
        raise ValueError("Command too long")
    # Guardrail: for HTTP exec, block true interactive TUI tools.
    # Non-interactive batch variants (e.g. `top -b -n 1`) are allowed.
    bad_tokens = {"vi", "vim", "nano", "less", "more", "htop", "watch"}
    first = cmd.split()[0].strip().lower() if cmd.split() else ""
    if first == "top":
        s = " ".join(cmd.split()).lower()
        if " -b" not in s and " --batch" not in s:
            raise ValueError("交互命令不支持 HTTP exec：请使用工作区终端的交互终端（PTY）")
    elif first in bad_tokens:
        raise ValueError("交互命令不支持 HTTP exec：请使用工作区终端的交互终端（PTY）")

    prefix = ""
    if cwd:
        c = str(cwd).strip()
        if len(c) > 512:
            raise ValueError("Invalid cwd")
        prefix = f"cd {posixpath.normpath(c)!s} && "

    t0 = time.perf_counter()
    transport = client.get_transport()
    if transport is None:
        raise RuntimeError("SSH transport not available")
    chan = transport.open_session(timeout=timeout_sec)
    chan.settimeout(0.5)
    chan.exec_command(prefix + cmd)

    stdout_buf = bytearray()
    stderr_buf = bytearray()
    stdout_trunc = False
    stderr_trunc = False
    deadline = time.perf_counter() + float(timeout_sec)

    while True:
        now = time.perf_counter()
        if now >= deadline:
            try:
                chan.close()
            except Exception:
                pass
            return {
                "ok": True,
                "timedOut": True,
                "exitCode": None,
                "stdout": stdout_buf.decode("utf-8", errors="replace"),
                "stderr": stderr_buf.decode("utf-8", errors="replace"),
                "stdoutTruncated": stdout_trunc,
                "stderrTruncated": stderr_trunc,
                "durationMs": int((now - t0) * 1000),
            }

        if chan.recv_ready():
            chunk = chan.recv(32_768)
            if chunk:
                remain = max_stdout_bytes - len(stdout_buf)
                if remain > 0:
                    stdout_buf += chunk[:remain]
                if len(chunk) > remain:
                    stdout_trunc = True
        if chan.recv_stderr_ready():
            chunk = chan.recv_stderr(32_768)
            if chunk:
                remain = max_stderr_bytes - len(stderr_buf)
                if remain > 0:
                    stderr_buf += chunk[:remain]
                if len(chunk) > remain:
                    stderr_trunc = True

        if chan.exit_status_ready():
            exit_code = chan.recv_exit_status()
            break

        time.sleep(0.02)

    dt_ms = int((time.perf_counter() - t0) * 1000)
    return {
        "ok": True,
        "timedOut": False,
        "exitCode": int(exit_code),
        "stdout": stdout_buf.decode("utf-8", errors="replace"),
        "stderr": stderr_buf.decode("utf-8", errors="replace"),
        "stdoutTruncated": stdout_trunc,
        "stderrTruncated": stderr_trunc,
        "durationMs": dt_ms,
    }


def is_dangerous_shell_command(cmd: str) -> str | None:
    """
    Server-side safety gate for ONE-SHOT exec.
    Keep this deliberately conservative and focused on destructive ops.

    Returns a short human-readable reason if blocked, otherwise None.
    """
    s = str(cmd or "").strip().lower()
    if not s:
        return None
    # Normalize repeated whitespace for simpler matching
    s = " ".join(s.split())

    # Highest-risk destructive primitives
    if s.startswith("rm "):
        return "包含 rm（删除文件/目录）"
    if " rm " in s or s.startswith("rm\t"):
        # best-effort: catch wrappers like "sudo rm ..."
        if " rm " in s:
            return "包含 rm（删除文件/目录）"

    if " mkfs" in (" " + s) or s.startswith("mkfs") or " mkfs." in (" " + s):
        return "包含 mkfs（格式化磁盘）"
    if " dd " in (" " + s) and " if=" in s:
        return "包含 dd if=（覆写磁盘/文件风险）"
    if s.startswith("reboot") or s.startswith("shutdown") or s.startswith("poweroff") or s.startswith("halt"):
        return "包含关机/重启命令"

    # Obvious data-destroying patterns
    if " rm -rf" in (" " + s) or " rm -fr" in (" " + s):
        return "包含 rm -rf（高危删除）"
    if " :(){:|:&};:" in s or "fork bomb" in s:
        return "包含 fork bomb 风险模式"

    return None


def sftp_listdir_on_client(
    *,
    client: paramiko.SSHClient,
    root_path: str,
    path: str,
    timeout_sec: float,
    limit: int = 200,
) -> dict[str, Any]:
    # timeout_sec currently not applied at sftp level; keep for signature consistency
    _ = timeout_sec
    p = _resolve_path(root_path, path)
    if limit < 1:
        limit = 1
    if limit > 500:
        limit = 500

    sftp = client.open_sftp()
    try:
        attrs = sftp.listdir_attr(p)
    finally:
        try:
            sftp.close()
        except Exception:
            pass

    items = []
    for it in attrs[:limit]:
        name = getattr(it, "filename", "") or ""
        if name in {".", ".."}:
            continue
        mode = int(getattr(it, "st_mode", 0) or 0)
        is_dir = bool(mode & 0o040000)
        items.append(
            {
                "name": name,
                "isDir": is_dir,
                "size": int(getattr(it, "st_size", 0) or 0),
                "mtime": int(getattr(it, "st_mtime", 0) or 0),
                "mode": mode,
            }
        )
    items.sort(key=lambda x: (0 if x["isDir"] else 1, x["name"].lower()))
    return {"ok": True, "path": p, "rootPath": posixpath.normpath(root_path), "items": items}


def sftp_read_text_on_client(
    *,
    client: paramiko.SSHClient,
    root_path: str,
    path: str,
    offset: int = 0,
    limit: int = 262_144,
    timeout_sec: float,
) -> dict[str, Any]:
    _ = timeout_sec
    p = _resolve_path(root_path, path)
    if offset < 0:
        offset = 0
    if limit < 1:
        limit = 1
    if limit > 524_288:
        limit = 524_288

    sftp = client.open_sftp()
    try:
        f = sftp.open(p, "rb")
        try:
            if offset:
                f.seek(offset)
            data = f.read(limit + 1)
        finally:
            f.close()
    finally:
        try:
            sftp.close()
        except Exception:
            pass

    truncated = len(data) > limit
    if truncated:
        data = data[:limit]
    is_binary = b"\x00" in data
    text = data.decode("utf-8", errors="replace")
    return {
        "ok": True,
        "path": p,
        "rootPath": posixpath.normpath(root_path),
        "offset": offset,
        "limit": limit,
        "truncated": truncated,
        "isBinary": is_binary,
        "encoding": "utf-8",
        "content": text,
    }


def sftp_write_text_on_client(
    *,
    client: paramiko.SSHClient,
    root_path: str,
    path: str,
    content: str,
    confirm: bool,
    create_backup: bool,
    timeout_sec: float,
) -> dict[str, Any]:
    _ = timeout_sec
    if not confirm:
        raise ValueError("Confirmation required")
    p = _resolve_path(root_path, path)
    data = (content or "").encode("utf-8")
    if len(data) > 2_000_000:
        raise ValueError("Content too large (max 2MB)")

    sftp = client.open_sftp()
    try:
        bak_path = None
        if create_backup:
            ts = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
            bak_path = f"{p}.bak_{ts}"
            try:
                sftp.stat(p)
                sftp.rename(p, bak_path)
            except FileNotFoundError:
                bak_path = None

        f = sftp.open(p, "wb")
        try:
            f.write(data)
        finally:
            f.close()
    finally:
        try:
            sftp.close()
        except Exception:
            pass

    return {"ok": True, "path": p, "rootPath": posixpath.normpath(root_path), "backupPath": bak_path}


def ssh_exec(
    *,
    host: dict[str, Any],
    auth: dict[str, Any],
    command: str,
    cwd: str | None,
    timeout_sec: float,
    max_stdout_bytes: int = 200_000,
    max_stderr_bytes: int = 200_000,
) -> dict[str, Any]:
    h = _sanitize_host(host)
    a = _sanitize_auth(auth)
    cmd = str(command or "").strip()
    if not cmd:
        raise ValueError("Missing command")
    if len(cmd) > 16_000:
        raise ValueError("Command too long")
    # Guardrail: for HTTP exec, block true interactive TUI tools.
    # Non-interactive batch variants (e.g. `top -b -n 1`) are allowed.
    bad_tokens = {"vi", "vim", "nano", "less", "more", "htop", "watch"}
    first = cmd.split()[0].strip().lower() if cmd.split() else ""
    if first == "top":
        s = " ".join(cmd.split()).lower()
        if " -b" not in s and " --batch" not in s:
            raise ValueError("交互命令不支持 HTTP exec：请使用工作区终端的交互终端（PTY）")
    elif first in bad_tokens:
        raise ValueError("交互命令不支持 HTTP exec：请使用工作区终端的交互终端（PTY）")

    prefix = ""
    if cwd:
        c = str(cwd).strip()
        if len(c) > 512:
            raise ValueError("Invalid cwd")
        # Use POSIX quoting; remote is assumed Linux in MVP.
        prefix = f"cd {posixpath.normpath(c)!s} && "

    t0 = time.perf_counter()
    cli = _connect_client(h, a, timeout_sec=timeout_sec)
    try:
        transport = cli.get_transport()
        if transport is None:
            raise RuntimeError("SSH transport not available")
        chan = transport.open_session(timeout=timeout_sec)
        chan.settimeout(0.5)
        chan.exec_command(prefix + cmd)

        stdout_buf = bytearray()
        stderr_buf = bytearray()
        stdout_trunc = False
        stderr_trunc = False
        deadline = time.perf_counter() + float(timeout_sec)

        while True:
            now = time.perf_counter()
            if now >= deadline:
                try:
                    chan.close()
                except Exception:
                    pass
                return {
                    "ok": True,
                    "timedOut": True,
                    "exitCode": None,
                    "stdout": stdout_buf.decode("utf-8", errors="replace"),
                    "stderr": stderr_buf.decode("utf-8", errors="replace"),
                    "stdoutTruncated": stdout_trunc,
                    "stderrTruncated": stderr_trunc,
                    "durationMs": int((now - t0) * 1000),
                }

            if chan.recv_ready():
                chunk = chan.recv(32_768)
                if chunk:
                    remain = max_stdout_bytes - len(stdout_buf)
                    if remain > 0:
                        stdout_buf += chunk[:remain]
                    if len(chunk) > remain:
                        stdout_trunc = True
            if chan.recv_stderr_ready():
                chunk = chan.recv_stderr(32_768)
                if chunk:
                    remain = max_stderr_bytes - len(stderr_buf)
                    if remain > 0:
                        stderr_buf += chunk[:remain]
                    if len(chunk) > remain:
                        stderr_trunc = True

            if chan.exit_status_ready():
                exit_code = chan.recv_exit_status()
                break

            time.sleep(0.02)

        dt_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "ok": True,
            "timedOut": False,
            "exitCode": int(exit_code),
            "stdout": stdout_buf.decode("utf-8", errors="replace"),
            "stderr": stderr_buf.decode("utf-8", errors="replace"),
            "stdoutTruncated": stdout_trunc,
            "stderrTruncated": stderr_trunc,
            "durationMs": dt_ms,
        }
    finally:
        try:
            cli.close()
        except Exception:
            pass


def _resolve_path(root_path: str, path: str) -> str:
    root = posixpath.normpath(str(root_path or "").strip() or "/")
    p = str(path or "").strip()
    if not p:
        p = "."
    # Interpret relative paths under root.
    if not p.startswith("/"):
        p = posixpath.join(root, p)
    p = posixpath.normpath(p)
    # Enforce sandbox within root (MVP safety baseline).
    if root != "/" and not (p == root or p.startswith(root + "/")):
        raise ValueError("Path is outside workspace rootPath")
    return p


def sftp_listdir(
    *,
    host: dict[str, Any],
    auth: dict[str, Any],
    root_path: str,
    path: str,
    timeout_sec: float,
    limit: int = 200,
) -> dict[str, Any]:
    h = _sanitize_host(host)
    a = _sanitize_auth(auth)
    p = _resolve_path(root_path, path)
    if limit < 1:
        limit = 1
    if limit > 500:
        limit = 500

    cli = _connect_client(h, a, timeout_sec=timeout_sec)
    try:
        sftp = cli.open_sftp()
        try:
            attrs = sftp.listdir_attr(p)
        finally:
            try:
                sftp.close()
            except Exception:
                pass

        items = []
        for it in attrs[:limit]:
            name = getattr(it, "filename", "") or ""
            if name in {".", ".."}:
                continue
            mode = int(getattr(it, "st_mode", 0) or 0)
            is_dir = bool(mode & 0o040000)
            items.append(
                {
                    "name": name,
                    "isDir": is_dir,
                    "size": int(getattr(it, "st_size", 0) or 0),
                    "mtime": int(getattr(it, "st_mtime", 0) or 0),
                    "mode": mode,
                }
            )
        # Sort: directories first then name
        items.sort(key=lambda x: (0 if x["isDir"] else 1, x["name"].lower()))
        return {"ok": True, "path": p, "rootPath": posixpath.normpath(root_path), "items": items}
    finally:
        try:
            cli.close()
        except Exception:
            pass


def sftp_read_text(
    *,
    host: dict[str, Any],
    auth: dict[str, Any],
    root_path: str,
    path: str,
    offset: int = 0,
    limit: int = 262_144,
    timeout_sec: float,
) -> dict[str, Any]:
    h = _sanitize_host(host)
    a = _sanitize_auth(auth)
    p = _resolve_path(root_path, path)
    if offset < 0:
        offset = 0
    if limit < 1:
        limit = 1
    if limit > 524_288:
        limit = 524_288

    cli = _connect_client(h, a, timeout_sec=timeout_sec)
    try:
        sftp = cli.open_sftp()
        try:
            f = sftp.open(p, "rb")
            try:
                if offset:
                    f.seek(offset)
                data = f.read(limit + 1)
            finally:
                f.close()
        finally:
            try:
                sftp.close()
            except Exception:
                pass

        truncated = len(data) > limit
        if truncated:
            data = data[:limit]
        # Heuristic: binary if contains NUL
        is_binary = b"\x00" in data
        text = data.decode("utf-8", errors="replace")
        return {
            "ok": True,
            "path": p,
            "rootPath": posixpath.normpath(root_path),
            "offset": offset,
            "limit": limit,
            "truncated": truncated,
            "isBinary": is_binary,
            "encoding": "utf-8",
            "content": text,
        }
    finally:
        try:
            cli.close()
        except Exception:
            pass


def sftp_write_text(
    *,
    host: dict[str, Any],
    auth: dict[str, Any],
    root_path: str,
    path: str,
    content: str,
    confirm: bool,
    create_backup: bool,
    timeout_sec: float,
) -> dict[str, Any]:
    if not confirm:
        raise ValueError("Confirmation required")
    h = _sanitize_host(host)
    a = _sanitize_auth(auth)
    p = _resolve_path(root_path, path)
    data = (content or "").encode("utf-8")
    if len(data) > 2_000_000:
        raise ValueError("Content too large (max 2MB)")

    cli = _connect_client(h, a, timeout_sec=timeout_sec)
    try:
        sftp = cli.open_sftp()
        try:
            bak_path = None
            if create_backup:
                ts = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
                bak_path = f"{p}.bak_{ts}"
                try:
                    sftp.stat(p)
                    sftp.rename(p, bak_path)
                except FileNotFoundError:
                    bak_path = None

            f = sftp.open(p, "wb")
            try:
                f.write(data)
            finally:
                f.close()
        finally:
            try:
                sftp.close()
            except Exception:
                pass

        return {"ok": True, "path": p, "rootPath": posixpath.normpath(root_path), "backupPath": bak_path}
    finally:
        try:
            cli.close()
        except Exception:
            pass


