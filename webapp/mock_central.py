"""Mock บ้านกลาง (BBT Platform) สำหรับทดสอบ SSO ก้อน C ในเครื่อง — ห้ามใช้เทสกับ production จริง
จำลอง: ประตูขาเข้า GET /api/sso/<house> · POST /api/auth/sso/exchange · POST /api/auth/sso/check
+ ช่องควบคุมสำหรับเทส: /test/issue (ออกตั๋วตรง) /test/disable /test/enable /test/revoke_badges /test/set_role
(ลอกจาก bbt-leadsheet/webapp/mock_central.py — เปลี่ยน slug เป็นของบ้านนี้)
"""
import time, secrets, os, datetime
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse

app = FastAPI(title="mock central")
HOUSE_KEY = os.environ.get("MOCK_HOUSE_KEY", "devkey-pnd51")
HOUSE_URL = os.environ.get("MOCK_HOUSE_URL", "http://localhost:8760")
HOUSE_SLUG = os.environ.get("MOCK_HOUSE_SLUG", "pnd51")
TICKET_TTL = 120

tickets = {}   # jti -> {exp, used}
badges = {}    # badge -> {user_id, exp}
state = {"disabled": False, "role": "editor", "user": {
    "id": "u-001", "display_name": "สมชาย ทดสอบ", "full_name": "สมชาย ทดสอบดี", "initial": "ST"}}
events = []    # log เหตุร้ายแรง (ตั๋วใช้ซ้ำ ฯลฯ)


def _issue_ticket():
    jti = "tk_" + secrets.token_urlsafe(16)
    tickets[jti] = {"exp": time.time() + TICKET_TTL, "used": False}
    return jti


@app.get("/api/sso/{house}")
def gate(house: str, path: str = "/"):
    if not path.startswith("/") or path.startswith("//") or any(c in path for c in ("\\", "..", ":", "#")):
        path = "/"
    t = _issue_ticket()
    return RedirectResponse(HOUSE_URL + path + "#ticket=" + t, status_code=302)


@app.get("/switch")
def switch():
    return {"page": "หน้าเลือกระบบ (mock)"}


def _auth_ok(request: Request) -> bool:
    return request.headers.get("authorization", "") == "Bearer " + HOUSE_KEY


@app.post("/api/auth/sso/exchange")
async def exchange(request: Request):
    if not _auth_ok(request):
        return JSONResponse({"error": "bad key"}, status_code=401)
    body = await request.json()
    if body.get("house") != HOUSE_SLUG:
        return JSONResponse({"error": "bad house"}, status_code=401)
    tk = tickets.get(body.get("ticket", ""))
    if not tk or tk["exp"] < time.time():
        return JSONResponse({"error": "ticket invalid"}, status_code=401)
    if tk["used"]:
        events.append("SEVERE: ตั๋วถูกใช้ซ้ำ")
        return JSONResponse({"error": "ticket reused"}, status_code=401)
    tk["used"] = True
    if state["disabled"]:
        return JSONResponse({"error": "no permission"}, status_code=403)
    # ผ่านประตูซ้ำ = บัตรใบเก่าของ user ถูกลบทันที (บัตรใช้งานได้ใบเดียวเสมอ)
    for b in [b for b, v in badges.items() if v["user_id"] == state["user"]["id"]]:
        del badges[b]
    badge = "ab_" + secrets.token_urlsafe(24)
    exp = time.time() + 12 * 3600
    badges[badge] = {"user_id": state["user"]["id"], "exp": exp}
    return {"ok": True, "badge": badge,
            "badge_expires_at": datetime.datetime.utcfromtimestamp(exp).isoformat(timespec="milliseconds") + "Z",
            "user": dict(state["user"]), "role": state["role"]}


@app.post("/api/auth/sso/check")
async def check(request: Request):
    if not _auth_ok(request):
        return JSONResponse({"error": "bad key"}, status_code=401)
    body = await request.json()
    b = badges.get(body.get("badge", ""))
    now = datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z"
    if not b:
        return {"ok": False, "reason": "badge_invalid", "checked_at": now}
    if b["exp"] < time.time():
        return {"ok": False, "reason": "badge_expired", "checked_at": now}
    if state["disabled"]:
        return {"ok": False, "reason": "disabled", "checked_at": now}
    return {"ok": True, "role": state["role"],
            "badge_expires_at": datetime.datetime.utcfromtimestamp(b["exp"]).isoformat(timespec="milliseconds") + "Z",
            "checked_at": now}


# ---- ช่องควบคุมเทส ----
@app.post("/test/issue")
def test_issue():
    return {"ticket": _issue_ticket()}


@app.post("/test/disable")
def test_disable():
    state["disabled"] = True; return {"ok": True}


@app.post("/test/enable")
def test_enable():
    state["disabled"] = False; return {"ok": True}


@app.post("/test/set_role")
async def test_set_role(request: Request):
    body = await request.json()
    state["role"] = body.get("role", "editor")
    if "user" in body:
        state["user"].update(body["user"])
    return {"ok": True, "state": state}


@app.post("/test/revoke_badges")
def test_revoke():
    badges.clear(); return {"ok": True}


@app.get("/test/events")
def test_events():
    return {"events": events, "badges": len(badges)}
