from __future__ import annotations

import os
import json
import tempfile
import unittest
from http.cookies import SimpleCookie
from unittest.mock import patch


_tmp = tempfile.TemporaryDirectory()
os.environ["DB_PATH"] = os.path.join(_tmp.name, "covixa-test.db")
os.environ["AUTH_SECRET"] = "test-secret-for-covixa-regression"
os.environ["BILLING_ENABLED"] = "1"
os.environ["BETA_INITIAL_CREDIT_CENTS"] = "0"
os.environ["BILLING_MIN_BALANCE_CENTS"] = "1"
os.environ["BILLING_PRICING_JSON"] = '{"default":{"prompt_per_1k_chars_cents":1,"completion_per_1k_chars_cents":1,"min_charge_cents":1}}'
os.environ["SUB_PLAN_PRICES_JSON"] = '{"pro":9900}'
os.environ["SUB_PLAN_CREDITS_JSON"] = '{"pro":0}'
os.environ["PAY_PROOF_DIR"] = os.path.join(_tmp.name, "pay_proofs")

from saas_api.app import main as main_mod  # noqa: E402
from saas_api.app import saas as saas_mod  # noqa: E402
from saas_api.app.accounting import get_user_balance_cents, ms  # noqa: E402
from saas_api.app.db import fetch_one  # noqa: E402
from saas_api.app.server import app  # noqa: E402


class AsgiResponse:
    def __init__(self, status_code: int, headers: list[tuple[bytes, bytes]], body: bytes):
        self.status_code = status_code
        self.headers = headers
        self.content = body
        self.text = body.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.text or "{}")


class MiniAsgiClient:
    def __init__(self, asgi_app):
        self.app = asgi_app
        self.cookies: dict[str, str] = {}

    async def request(self, method: str, path: str, *, json_body: dict | None = None):
        if "?" in path:
            route_path, query = path.split("?", 1)
        else:
            route_path, query = path, ""
        raw_body = b""
        headers: list[tuple[bytes, bytes]] = [(b"host", b"testserver")]
        if json_body is not None:
            raw_body = json.dumps(json_body).encode("utf-8")
            headers.append((b"content-type", b"application/json"))
        if self.cookies:
            cookie_header = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
            headers.append((b"cookie", cookie_header.encode("utf-8")))

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method.upper(),
            "scheme": "http",
            "path": route_path,
            "raw_path": route_path.encode("utf-8"),
            "query_string": query.encode("utf-8"),
            "headers": headers,
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
        }
        sent = False
        status_code = 500
        response_headers: list[tuple[bytes, bytes]] = []
        chunks: list[bytes] = []

        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": raw_body, "more_body": False}
            return {"type": "http.disconnect"}

        async def send(message):
            nonlocal status_code, response_headers
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                response_headers = list(message.get("headers") or [])
            elif message["type"] == "http.response.body":
                chunks.append(message.get("body") or b"")

        await self.app(scope, receive, send)
        for key, value in response_headers:
            if key.lower() == b"set-cookie":
                cookie = SimpleCookie()
                cookie.load(value.decode("latin1"))
                for name, morsel in cookie.items():
                    self.cookies[name] = morsel.value
        return AsgiResponse(status_code, response_headers, b"".join(chunks))

    async def get(self, path: str):
        return await self.request("GET", path)

    async def post(self, path: str, *, json: dict | None = None):
        return await self.request("POST", path, json_body=json)


async def _register(client: MiniAsgiClient, email: str, password: str = "Passw0rd!"):
    r = await client.post("/api/auth/register", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["user"]


async def _fake_stream_chat(*args, **kwargs):
    on_usage = kwargs.get("on_usage")
    if callable(on_usage):
        on_usage({"prompt_tokens": 1, "completion_tokens": 1})
    yield b"ok"


class CovixaRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = MiniAsgiClient(app)

    async def test_health_is_available(self):
        r = await self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json().get("ok"))

    async def test_api_chat_requires_login(self):
        r = await self.client.post("/api/chat", json={"message": "hello"})
        self.assertEqual(r.status_code, 401)

    async def test_api_chat_charges_logged_in_user(self):
        user = await _register(self.client, "chat-user@example.com")
        saas_mod._DB.execute(
            "INSERT INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at) VALUES(?,?,?,?,?,?,?);",
            ("seed_chat_balance", int(user["id"]), "recharge", 1000, "", "seed_chat_balance", ms()),
        )
        saas_mod._DB.commit()
        before = get_user_balance_cents(saas_mod._DB, int(user["id"]))
        with patch.object(main_mod, "stream_chat", _fake_stream_chat):
            r = await self.client.post("/api/chat", json={"session_id": "s1", "message": "hello", "model": "test-model"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("ok", r.text)
        after = get_user_balance_cents(saas_mod._DB, int(user["id"]))
        self.assertLess(after, before)
        usage = fetch_one(saas_mod._DB, "SELECT COUNT(1) AS n FROM llm_usage WHERE user_id=?;", (int(user["id"]),))
        self.assertGreaterEqual(int((usage or {}).get("n") or 0), 1)

    async def test_disabled_user_cannot_login_or_use_existing_session(self):
        user = await _register(self.client, "disabled-user@example.com")
        saas_mod._DB.execute("UPDATE users SET status='disabled' WHERE id=?;", (int(user["id"]),))
        saas_mod._DB.commit()

        existing_session = await self.client.get("/api/me")
        self.assertEqual(existing_session.status_code, 403)

        fresh = MiniAsgiClient(app)
        login = await fresh.post("/api/auth/login", json={"identifier": "disabled-user@example.com", "password": "Passw0rd!"})
        self.assertEqual(login.status_code, 403)

    async def test_subscription_activation_deducts_balance(self):
        user = await _register(self.client, "sub-user@example.com")
        uid = int(user["id"])
        saas_mod._DB.execute(
            "INSERT INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at) VALUES(?,?,?,?,?,?,?);",
            ("seed_sub_balance", uid, "recharge", 9900, "", "seed_sub_balance", ms()),
        )
        saas_mod._DB.commit()
        r = await self.client.post("/api/me/subscription/activate", json={"plan": "pro", "months": 1, "requestId": "sub_test_1"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["subscription"]["status"], "active")
        self.assertEqual(get_user_balance_cents(saas_mod._DB, uid), 0)

    async def test_admin_orders_and_ledger_interfaces(self):
        admin = await _register(self.client, "admin-user@example.com")
        uid = int(admin["id"])
        saas_mod._DB.execute("UPDATE users SET role='admin' WHERE id=?;", (uid,))
        saas_mod._DB.execute(
            "INSERT INTO recharge_orders(id,user_id,channel,amount_cents,status,note,created_at,paid_at,credited_at,submitted_at,proof_path) VALUES(?,?,?,?,?,?,?,?,?,?,?);",
            ("order_test_1", uid, "alipay", 9900, "submitted", "test", ms(), ms(), None, ms(), "/tmp/proof.png"),
        )
        saas_mod._DB.execute(
            "INSERT INTO ledger(id,user_id,entry_type,amount_cents,period,ref_id,created_at) VALUES(?,?,?,?,?,?,?);",
            ("ledger_test_1", uid, "recharge", 9900, "", "ledger_test_1", ms()),
        )
        saas_mod._DB.commit()

        orders = await self.client.get("/api/admin/recharge_orders?status=submitted")
        self.assertEqual(orders.status_code, 200, orders.text)
        self.assertTrue(any(item["id"] == "order_test_1" for item in orders.json().get("orders", [])))

        ledger = await self.client.get("/api/admin/ledger")
        self.assertEqual(ledger.status_code, 200, ledger.text)
        self.assertTrue(any(item["id"] == "ledger_test_1" for item in ledger.json().get("items", [])))

    async def test_mvp_transaction_chain_manual_recharge_to_ai_usage(self):
        user_client = MiniAsgiClient(app)
        admin_client = MiniAsgiClient(app)

        user = await _register(user_client, "mvp-chain-user@example.com")
        uid = int(user["id"])
        admin = await _register(admin_client, "mvp-chain-admin@example.com")
        admin_id = int(admin["id"])
        saas_mod._DB.execute("UPDATE users SET role='admin' WHERE id=?;", (admin_id,))
        saas_mod._DB.commit()

        pricing = await user_client.get("/api/me/billing")
        self.assertEqual(pricing.status_code, 200, pricing.text)
        self.assertEqual(pricing.json().get("plan"), "pro")
        self.assertEqual(get_user_balance_cents(saas_mod._DB, uid), 0)

        proof_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        submitted = await user_client.post(
            "/api/pay/manual/submit",
            json={
                "channel": "alipay",
                "amountCents": 9900,
                "note": "mvp-chain-test",
                "proofDataUrl": proof_png,
            },
        )
        self.assertEqual(submitted.status_code, 200, submitted.text)
        order_id = submitted.json().get("orderId")
        self.assertTrue(order_id)

        orders = await admin_client.get("/api/admin/recharge_orders?status=submitted")
        self.assertEqual(orders.status_code, 200, orders.text)
        self.assertTrue(any(item["id"] == order_id for item in orders.json().get("orders", [])))

        credited = await admin_client.post("/api/admin/pay/manual/credit", json={"orderId": order_id})
        self.assertEqual(credited.status_code, 200, credited.text)
        self.assertTrue(credited.json().get("credited"))
        balance_after_credit = get_user_balance_cents(saas_mod._DB, uid)
        self.assertGreaterEqual(balance_after_credit, 9900)

        after_credit_billing = await user_client.get("/api/me/billing")
        self.assertEqual(after_credit_billing.status_code, 200, after_credit_billing.text)
        ledger_items = after_credit_billing.json().get("ledger", [])
        self.assertTrue(any(item["entry_type"] == "recharge" and item["ref_id"] == order_id for item in ledger_items))

        with patch.object(main_mod, "stream_chat", _fake_stream_chat):
            chat = await user_client.post("/api/chat", json={"session_id": "mvp-chain", "message": "hello", "model": "test-model"})
        self.assertEqual(chat.status_code, 200, chat.text)
        self.assertLess(get_user_balance_cents(saas_mod._DB, uid), balance_after_credit)

        usage = fetch_one(saas_mod._DB, "SELECT COUNT(1) AS n FROM llm_usage WHERE user_id=?;", (uid,))
        self.assertGreaterEqual(int((usage or {}).get("n") or 0), 1)
        llm_ledger = fetch_one(
            saas_mod._DB,
            "SELECT COUNT(1) AS n FROM ledger WHERE user_id=? AND entry_type='llm_usage' AND amount_cents<0;",
            (uid,),
        )
        self.assertGreaterEqual(int((llm_ledger or {}).get("n") or 0), 1)


if __name__ == "__main__":
    unittest.main()
