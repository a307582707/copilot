from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Iterable

import httpx


@dataclass(frozen=True)
class LlmUpstream:
    name: str
    base_url: str
    api_key: str | None
    default_model: str | None = None
    kind: str = "openai_compat"  # "openai_compat" | "ollama"


def _norm_url(u: str) -> str:
    return (u or "").strip().rstrip("/")


def _env_bool(name: str, default: bool = False) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    if not v:
        return default
    return v in {"1", "true", "yes", "y", "on"}


def load_upstreams() -> list[LlmUpstream]:
    """
    Load LLM upstreams from env.

    Preferred: LLM_UPSTREAMS_JSON = JSON array:
      [{"name":"qwen","kind":"openai_compat","base_url":"https://.../v1","api_key":"...","default_model":"qwen-plus"}, ...]

    Fallback: single OpenAI-compatible upstream via:
      LLM_BASE_URL, LLM_API_KEY, LLM_DEFAULT_MODEL

    Legacy: Ollama via:
      OLLAMA_BASE_URL, OLLAMA_MODEL
    """
    raw = (os.environ.get("LLM_UPSTREAMS_JSON") or "").strip()
    ups: list[LlmUpstream] = []

    if raw:
        try:
            arr = json.loads(raw)
            if isinstance(arr, list):
                for it in arr:
                    if not isinstance(it, dict):
                        continue
                    name = str(it.get("name") or "").strip() or "llm"
                    kind = str(it.get("kind") or "openai_compat").strip() or "openai_compat"
                    base_url = _norm_url(str(it.get("base_url") or it.get("baseUrl") or ""))
                    api_key = str(it.get("api_key") or it.get("apiKey") or "").strip() or None
                    default_model = str(it.get("default_model") or it.get("defaultModel") or "").strip() or None
                    if not base_url:
                        continue
                    ups.append(LlmUpstream(name=name, kind=kind, base_url=base_url, api_key=api_key, default_model=default_model))
        except Exception:
            # ignore; fall back to single provider
            ups = []

    if not ups:
        base_url = _norm_url(os.environ.get("LLM_BASE_URL", ""))
        api_key = (os.environ.get("LLM_API_KEY") or "").strip() or None
        default_model = (os.environ.get("LLM_DEFAULT_MODEL") or "").strip() or None
        if base_url:
            ups.append(LlmUpstream(name="llm", kind="openai_compat", base_url=base_url, api_key=api_key, default_model=default_model))

    # If still empty, keep legacy Ollama mode as last resort
    if not ups:
        ob = _norm_url(os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434"))
        om = (os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:1.5b").strip()
        ups.append(LlmUpstream(name="ollama", kind="ollama", base_url=ob, api_key=None, default_model=om))

    return ups


def _split_model(model: str) -> tuple[str | None, str]:
    m = (model or "").strip()
    if "/" in m:
        a, b = m.split("/", 1)
        a = a.strip()
        b = b.strip()
        if a and b:
            return a, b
    return None, m


def _auth_headers(api_key: str | None) -> dict[str, str]:
    if not api_key:
        return {}
    return {"Authorization": f"Bearer {api_key}"}


async def list_models(upstreams: list[LlmUpstream]) -> tuple[list[str], str | None]:
    """
    Return (models, default).
    - If multiple upstreams: model ids are prefixed as "{name}/{id}" to make routing deterministic.
    """
    multi = len(upstreams) > 1
    names: list[str] = []
    default: str | None = None

    for idx, up in enumerate(upstreams):
        try:
            if up.kind == "ollama":
                url = up.base_url + "/api/tags"
                async with httpx.AsyncClient(timeout=4.0, trust_env=False) as client:
                    r = await client.get(url)
                    r.raise_for_status()
                    data = r.json() if r.content else {}
                    items = data.get("models") or []
                    ms: list[str] = []
                    for m in items:
                        n = m.get("name") if isinstance(m, dict) else None
                        if isinstance(n, str) and n:
                            ms.append(n)
                    for m in ms:
                        names.append(f"{up.name}/{m}" if multi else m)
                    dm = up.default_model or (ms[0] if ms else None)
                    if dm and default is None:
                        default = f"{up.name}/{dm}" if multi else dm
                continue

            # openai_compat
            # Support both base_url variants:
            # - https://api.xxx.com            -> /v1/models
            # - https://dashscope.aliyuncs.com/compatible-mode/v1 -> /models
            url = up.base_url + ("/models" if up.base_url.endswith("/v1") else "/v1/models")
            async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
                r = await client.get(url, headers=_auth_headers(up.api_key))
                r.raise_for_status()
                data = r.json() if r.content else {}
                items = data.get("data") or []
                ms: list[str] = []
                for it in items:
                    mid = it.get("id") if isinstance(it, dict) else None
                    if isinstance(mid, str) and mid:
                        ms.append(mid)
                for m in ms:
                    names.append(f"{up.name}/{m}" if multi else m)
                dm = up.default_model or (ms[0] if ms else None)
                if dm and default is None:
                    default = f"{up.name}/{dm}" if multi else dm
        except Exception:
            # ignore a single upstream failure; user may configure only some providers
            if idx == 0 and default is None and up.default_model:
                default = f"{up.name}/{up.default_model}" if multi else up.default_model
            continue

    # de-dup (keep order)
    seen: set[str] = set()
    uniq: list[str] = []
    for n in names:
        if n in seen:
            continue
        seen.add(n)
        uniq.append(n)

    return uniq, default


async def stream_chat(
    upstreams: list[LlmUpstream],
    message: str,
    model: str | None,
    image_data_urls: list[str] | None = None,
    system_prompt: str = "You are a helpful coding assistant.",
    on_usage: Callable[[dict], None] | None = None,
) -> AsyncIterator[bytes]:
    """
    Stream plain-text tokens for the UI.
    - If model is prefixed with "{name}/...": route to that upstream only.
    - If model is not prefixed and multiple upstreams exist: try upstreams in order (best-effort fallback).
    """
    want_name, want_model = _split_model(model or "")
    multi = len(upstreams) > 1

    candidates: Iterable[LlmUpstream]
    if want_name:
        candidates = [u for u in upstreams if u.name == want_name]
    else:
        candidates = list(upstreams)

    last_err: str | None = None
    for up in candidates:
        use_model = want_model.strip() if want_model.strip() else (up.default_model or "")
        if not use_model:
            last_err = f"missing model for upstream {up.name}"
            continue
        try:
            if up.kind == "ollama":
                async for b in _stream_ollama(up, message, use_model, system_prompt=system_prompt, on_usage=on_usage):
                    yield b
                return
            async for b in _stream_openai_compat(
                up,
                message,
                use_model,
                image_data_urls=image_data_urls or [],
                system_prompt=system_prompt,
                on_usage=on_usage,
            ):
                yield b
            return
        except Exception as e:
            last_err = str(e)
            # if pinned to a name, don't fallback
            if want_name:
                break
            continue

    raise RuntimeError(last_err or "No LLM upstream available")


async def _stream_ollama(
    up: LlmUpstream,
    message: str,
    model: str,
    system_prompt: str,
    on_usage: Callable[[dict], None] | None = None,
) -> AsyncIterator[bytes]:
    url = up.base_url + "/api/chat"
    payload = {
        "model": model,
        "stream": True,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": message},
        ],
    }
    async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
        async with client.stream("POST", url, json=payload) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                msg = obj.get("message") or {}
                content = msg.get("content")
                if content:
                    yield str(content).encode("utf-8")
                # Ollama may include usage fields when done.
                if obj.get("done") is True and on_usage is not None:
                    try:
                        pu = obj.get("prompt_eval_count")
                        cu = obj.get("eval_count")
                        if isinstance(pu, int) or isinstance(cu, int):
                            on_usage(
                                {
                                    "kind": "ollama",
                                    "prompt_tokens": int(pu) if isinstance(pu, int) else None,
                                    "completion_tokens": int(cu) if isinstance(cu, int) else None,
                                }
                            )
                    except Exception:
                        pass
                if obj.get("done") is True:
                    break


async def _stream_openai_compat(
    up: LlmUpstream,
    message: str,
    model: str,
    image_data_urls: list[str],
    system_prompt: str,
    on_usage: Callable[[dict], None] | None = None,
) -> AsyncIterator[bytes]:
    # Expect base_url WITHOUT /v1 suffix or with it; normalize both.
    base = up.base_url
    url = base + ("/v1/chat/completions" if not base.endswith("/v1") else "/chat/completions")
    headers = {"Content-Type": "application/json", **_auth_headers(up.api_key)}
    user_content: object
    if image_data_urls:
        parts: list[dict] = [{"type": "text", "text": message}]
        for u in image_data_urls[:3]:
            if isinstance(u, str) and u.startswith("data:image/"):
                parts.append({"type": "image_url", "image_url": {"url": u}})
        user_content = parts
    else:
        user_content = message

    payload = {
        "model": model,
        "stream": True,
        # Some OpenAI-compatible providers support include_usage in stream.
        # Safe to send; ignored by providers that don't recognize it.
        "stream_options": {"include_usage": True},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    }

    async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line:
                    continue
                # SSE format: "data: {...}" or "data: [DONE]"
                if not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if not data:
                    continue
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                # Some providers may return usage in streaming events.
                if on_usage is not None:
                    try:
                        usage = obj.get("usage") if isinstance(obj, dict) else None
                        if isinstance(usage, dict):
                            pt = usage.get("prompt_tokens")
                            ct = usage.get("completion_tokens")
                            if isinstance(pt, int) or isinstance(ct, int):
                                on_usage(
                                    {
                                        "kind": "openai_compat",
                                        "prompt_tokens": int(pt) if isinstance(pt, int) else None,
                                        "completion_tokens": int(ct) if isinstance(ct, int) else None,
                                    }
                                )
                    except Exception:
                        pass
                choices = obj.get("choices") or []
                if not choices or not isinstance(choices, list):
                    continue
                delta = choices[0].get("delta") if isinstance(choices[0], dict) else None
                if isinstance(delta, dict):
                    content = delta.get("content")
                    if content:
                        yield str(content).encode("utf-8")


