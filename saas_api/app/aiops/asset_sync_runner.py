from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from ..db import connect
from .asset_sync_store import (
    create_sync_run,
    find_active_sync_run,
    get_sync_run,
    list_due_schedules,
    mark_schedule_enqueued,
    update_sync_run,
)
from .settings import get_setting


DEFAULT_SYNC_REGIONS = ["us-west-1", "cn-shenzhen"]


def _now() -> int:
    return int(time.time())


def _parse_settings_list(raw: str) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        obj = json.loads(raw)
    except Exception:
        return []
    if not isinstance(obj, list):
        return []
    return [it for it in obj if isinstance(it, dict)]


def _load_cli_accounts() -> list[dict[str, Any]]:
    conn = connect()
    try:
        raw = get_setting(conn, "asset_sync.cli_accounts")
    finally:
        try:
            conn.release()
        except Exception:
            pass
    out: list[dict[str, Any]] = []
    for item in _parse_settings_list(raw):
        cli_id = str(item.get("id") or "").strip()
        if not cli_id:
            continue
        out.append(
            {
                "id": cli_id,
                "name": str(item.get("name") or "").strip(),
                "profileDefault": str(item.get("profileDefault") or "").strip(),
                "profileDataworks": str(item.get("profileDataworks") or "").strip(),
                "cloudAccountKeys": [str(v).strip() for v in (item.get("cloudAccountKeys") if isinstance(item.get("cloudAccountKeys"), list) else []) if str(v).strip()],
                "regions": [str(v).strip() for v in (item.get("regions") if isinstance(item.get("regions"), list) else []) if str(v).strip()],
                "enabled": bool(item.get("enabled") if item.get("enabled") is not None else True),
            }
        )
    return out


def _resolve_cli_account(cli_account_id: str) -> dict[str, Any]:
    for item in _load_cli_accounts():
        if str(item.get("id") or "") == str(cli_account_id or "").strip() and bool(item.get("enabled")):
            return item
    raise RuntimeError("CLI 账号不存在或已停用")


def _candidate_roots() -> list[Path]:
    out: list[Path] = []
    for raw in [
        os.environ.get("AIOPS_DISCOVERY_ROOT", "").strip(),
        str(Path(__file__).resolve().parents[2]),
        str(Path(__file__).resolve().parents[3]),
    ]:
        if not raw:
            continue
        p = Path(raw).resolve()
        if p not in out:
            out.append(p)
    return out


def _project_root() -> Path:
    for root in _candidate_roots():
        if (root / "cicd" / "scripts" / "discover_aliyun_assets_v2_impl.py").exists():
            return root
    raise RuntimeError("未找到资产发现脚本目录，请先把 cicd/scripts 同步到 API 运行环境")


def _env_json_for_region(root: Path, region: str) -> Path:
    configured = (os.environ.get("AIOPS_SYNC_ENV_JSON") or "").strip()
    if configured:
        return Path(configured)
    return root / "config" / "environments" / f"{region}.json"


def _env_name_for_region(region: str) -> str:
    return region


def _target_regions(run_region: str, cli: dict[str, Any]) -> list[str]:
    region = str(run_region or "all").strip() or "all"
    if region != "all":
        return [region]
    cli_regions = [str(v).strip() for v in (cli.get("regions") if isinstance(cli.get("regions"), list) else []) if str(v).strip()]
    return cli_regions or DEFAULT_SYNC_REGIONS


def _run_step(*, cmd: list[str], env: dict[str, str], cwd: Path, timeout_sec: int) -> str:
    cp = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_sec,
    )
    stdout = (cp.stdout or "").strip()
    stderr = (cp.stderr or "").strip()
    last_line = ""
    for line in reversed(stdout.splitlines()):
        if line.strip():
            last_line = line.strip()
            break
    if cp.returncode != 0:
        err = stderr or last_line or stdout or "unknown error"
        raise RuntimeError(err[:4000])
    return (last_line or stdout or "ok")[:1000]


def _ensure_prerequisites() -> None:
    if shutil.which("aliyun") is None:
        raise RuntimeError("当前 API 服务器未安装 aliyun CLI，无法执行资产发现")


def _execute_sync(run_row: dict[str, Any]) -> str:
    _ensure_prerequisites()
    cli = _resolve_cli_account(str(run_row.get("cli_account_id") or ""))
    root = _project_root()
    python_bin = sys.executable or "python3"
    regions = _target_regions(str(run_row.get("region") or "all"), cli)
    profile_default = str(cli.get("profileDefault") or "").strip()
    profile_dataworks = str(cli.get("profileDataworks") or profile_default).strip()
    account_name = profile_default or str(cli.get("name") or "").strip()
    if not profile_default:
        raise RuntimeError("CLI 账号缺少 Default Profile，无法执行基础资产发现")
    if not profile_dataworks:
        raise RuntimeError("CLI 账号缺少 DataWorks Profile，无法执行 DataWorks 深度发现")

    summaries: list[str] = []
    for region in regions:
        env_name = _env_name_for_region(region)
        env_json = _env_json_for_region(root, region)
        run_env = {
            **os.environ,
            "AIOPS_SYNC_REGION": region,
            "AIOPS_SYNC_ENV": env_name,
            "AIOPS_SYNC_PROFILE_DEFAULT": profile_default,
            "AIOPS_SYNC_PROFILE_DATAWORKS": profile_dataworks,
            "AIOPS_SYNC_ACCOUNT_NAME": account_name,
            "AIOPS_SYNC_ENV_JSON": str(env_json),
        }
        summaries.append(
            "base[%s]=%s"
            % (
                region,
                _run_step(
                    cmd=[python_bin, str(root / "cicd" / "scripts" / "discover_aliyun_assets_v2_impl.py"), "--region", region],
                    env=run_env,
                    cwd=root,
                    timeout_sec=1800,
                ),
            )
        )
        summaries.append(
            "starrocks[%s]=%s"
            % (
                region,
                _run_step(
                    cmd=[python_bin, str(root / "cicd" / "scripts" / "discover_starrocks_deep.py"), "--region", region],
                    env=run_env,
                    cwd=root,
                    timeout_sec=1200,
                ),
            )
        )
        summaries.append(
            "flink[%s]=%s"
            % (
                region,
                _run_step(
                    cmd=[python_bin, str(root / "cicd" / "scripts" / "discover_flink_deep.py"), "--region", region],
                    env=run_env,
                    cwd=root,
                    timeout_sec=1200,
                ),
            )
        )
        summaries.append(
            "dataworks[%s]=%s"
            % (
                region,
                _run_step(
                    cmd=[python_bin, str(root / "cicd" / "scripts" / "discover_dataworks_deep.py"), "--region", region],
                    env=run_env,
                    cwd=root,
                    timeout_sec=1800,
                ),
            )
        )
    return " ; ".join(summaries)[:1000]


class AssetSyncRuntime:
    def __init__(self) -> None:
        self._queue: queue.Queue[str] = queue.Queue()
        self._stop_event = threading.Event()
        self._start_lock = threading.Lock()
        self._worker: threading.Thread | None = None
        self._scheduler: threading.Thread | None = None

    def start(self) -> None:
        with self._start_lock:
            if self._worker and self._worker.is_alive() and self._scheduler and self._scheduler.is_alive():
                return
            self._stop_event.clear()
            self._worker = threading.Thread(target=self._worker_loop, name="asset-sync-worker", daemon=True)
            self._scheduler = threading.Thread(target=self._scheduler_loop, name="asset-sync-scheduler", daemon=True)
            self._worker.start()
            self._scheduler.start()

    def stop(self) -> None:
        self._stop_event.set()

    def enqueue(self, run_id: str) -> None:
        self.start()
        self._queue.put(str(run_id or "").strip())

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                run_id = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if not run_id:
                continue
            conn = connect()
            try:
                row = get_sync_run(conn, run_id)
                if not row:
                    continue
                update_sync_run(conn, run_id, status="running", started_at=_now(), summary="同步开始执行")
                try:
                    summary = _execute_sync(row)
                    update_sync_run(conn, run_id, status="success", finished_at=_now(), summary=summary, error="")
                except Exception as e:
                    update_sync_run(conn, run_id, status="failed", finished_at=_now(), summary="同步失败", error=str(e))
            finally:
                try:
                    conn.release()
                except Exception:
                    pass

    def _scheduler_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                conn = connect()
                try:
                    for schedule in list_due_schedules(conn):
                        active = find_active_sync_run(
                            conn,
                            cloud_account_key=str(schedule.get("cloud_account_key") or ""),
                            cli_account_id=str(schedule.get("cli_account_id") or ""),
                            region=str(schedule.get("region") or "all"),
                        )
                        if active:
                            mark_schedule_enqueued(conn, schedule_id=str(schedule.get("id") or ""), run_id=str(active.get("id") or ""), now_ts=_now())
                            continue
                        run_id = create_sync_run(
                            conn,
                            cloud_account_key=str(schedule.get("cloud_account_key") or ""),
                            cli_account_id=str(schedule.get("cli_account_id") or ""),
                            region=str(schedule.get("region") or "all"),
                            trigger_mode="schedule",
                            triggered_by=int(schedule.get("updated_by")) if isinstance(schedule.get("updated_by"), int) else None,
                        )
                        mark_schedule_enqueued(conn, schedule_id=str(schedule.get("id") or ""), run_id=run_id, now_ts=_now())
                        self._queue.put(run_id)
                finally:
                    try:
                        conn.release()
                    except Exception:
                        pass
            except Exception:
                # Scheduler should never crash the API process.
                pass
            self._stop_event.wait(15.0)


_RUNTIME: AssetSyncRuntime | None = None
_RUNTIME_LOCK = threading.Lock()


def get_asset_sync_runtime() -> AssetSyncRuntime:
    global _RUNTIME
    with _RUNTIME_LOCK:
        if _RUNTIME is None:
            _RUNTIME = AssetSyncRuntime()
        return _RUNTIME


def start_asset_sync_runtime() -> None:
    get_asset_sync_runtime().start()


def stop_asset_sync_runtime() -> None:
    get_asset_sync_runtime().stop()


def enqueue_sync_run(run_id: str) -> None:
    get_asset_sync_runtime().enqueue(run_id)
