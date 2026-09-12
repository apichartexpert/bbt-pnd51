"""
ภ.ง.ด.51 — BBT · Web backend (FastAPI + SQLite/PostgreSQL)
บ้าน `pnd51` ตามมาตรฐานรวมบ้าน ก้อน C (คู่มือ: SSO-HOUSE.md · โครงลอกจาก bbt-leadsheet/webapp/main.py ซึ่งผ่าน grill แล้ว)

โหมดฐานข้อมูล:
  - ค่าเริ่มต้น: SQLite  ->  sqlite:///./data/pnd51.db
  - โปรดักชัน (คลาวด์): ตั้ง env  DATABASE_URL=postgresql://user:pass@host:5432/dbname

การเข้าถึง:
  - ก่อน SSO ขึ้นจริง: ACCESS_CODE=<รหัส> รหัสรวมหนึ่งรหัส (ชั่วคราว)
  - SSO_ENABLED=1 + BBT_URL + HOUSE_KEY = เข้าทางประตูบ้านกลางทางเดียว (C9 — ACCESS_CODE ถูกปิดอัตโนมัติ)
"""
import os, json, hashlib, secrets, logging, datetime
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy import create_engine, MetaData, Table, Column, String, Text, select, insert, update, delete

log = logging.getLogger("uvicorn.error")

# ---------- ฐานข้อมูล ----------
_raw_db_url = os.environ.get("DATABASE_URL", "").strip()
# กันค่าที่ copy/paste มาพร้อมเปลือก เช่น  psql 'postgresql://...'  หรือมี quote/ขึ้นบรรทัดติดมา
if _raw_db_url.lower().startswith("psql"):
    _raw_db_url = _raw_db_url[4:].strip()
_raw_db_url = "".join(_raw_db_url.strip("'\"").split())
DATABASE_URL = _raw_db_url or "sqlite:///./data/pnd51.db"
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
if DATABASE_URL.startswith("sqlite"):
    os.makedirs("data", exist_ok=True)
engine = create_engine(DATABASE_URL, connect_args=_connect_args, pool_pre_ping=True)

metadata = MetaData()
companies = Table(
    "companies", metadata,
    Column("id", String(64), primary_key=True),
    Column("name", Text, nullable=False, default=""),
    Column("data", Text, nullable=False),          # JSON ของบริษัททั้งก้อน (โครงเดียวกับที่เคยอยู่บน Firestore)
    Column("updated_at", String(40), nullable=False, default=""),
)
tombs = Table(                                      # tombstone บริษัทที่ถูกลบ — รวมด้วย max ของแต่ละช่อง (โครงเดียวกับ db.tombs ฝั่งแอป)
    "tombs", metadata,
    Column("id", String(64), primary_key=True),
    Column("del_at", String(20), nullable=False, default="0"),     # epoch ms (สตริง — เก็บตามค่าจากแอป)
    Column("undel_at", String(20), nullable=False, default="0"),
)
users = Table(                                      # mapping เท่านั้น (C6) — แหล่งความจริงเรื่องตัวตน/สิทธิ์คือบ้านกลาง
    "users", metadata,                              # display_name/last_role เป็น cache สำหรับแสดงผล/dropdown ผู้รับผิดชอบ · refresh ทุกครั้งที่แลกบัตร/ตรวจ
    Column("central_user_id", String(64), primary_key=True),
    Column("display_name", Text, nullable=False, default=""),
    Column("last_role", String(16), nullable=False, default=""),   # cache เพื่อกรอง dropdown เท่านั้น — สิทธิ์จริงเช็คจากผลตรวจสด
    Column("updated_at", String(40), nullable=False, default=""),
)
sessions = Table(                                   # session ของบ้าน ผูกกับบัตร (C3 — บัตรอยู่ server เท่านั้น)
    "sessions", metadata,
    Column("token_hash", String(64), primary_key=True),    # sha256 ของ token ใน cookie (กัน DB หลุดแล้วสวม session)
    Column("badge", Text, nullable=False),
    Column("badge_expires_at", String(40), nullable=False, default=""),
    Column("user_json", Text, nullable=False, default="{}"),
    Column("role", String(16), nullable=False, default="viewer"),
    Column("sso_at", String(40), nullable=False, default=""),      # เวลาแลกตั๋ว — ใช้ตัดสินความสด re-SSO ของการกระทำระดับ full
    Column("last_check_at", String(40), nullable=False, default=""),
    Column("expires_at", String(40), nullable=False, default=""),  # min(แลกตั๋ว+12ชม., badge_expires_at) — ไม่มีต่ออายุ
)
metadata.create_all(engine)

# ---------- แอป ----------
app = FastAPI(title="BBT PND51")
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()

# ---------- SSO บ้านกลาง (spec ก้อน C — คู่มือใน SSO-HOUSE.md) ----------
BBT_URL = os.environ.get("BBT_URL", "").strip().rstrip("/")
HOUSE_KEY = os.environ.get("HOUSE_KEY", "").strip()          # กุญแจเข้าบ้าน (entry) — env เท่านั้น (C7)
HOUSE_SLUG = os.environ.get("HOUSE_SLUG", "pnd51").strip()
SSO_ENABLED = os.environ.get("SSO_ENABLED", "").strip() == "1"
if SSO_ENABLED and (not BBT_URL or not HOUSE_KEY):
    raise RuntimeError("SSO_ENABLED=1 แต่ยังไม่ได้ตั้ง BBT_URL / HOUSE_KEY")
if SSO_ENABLED and ACCESS_CODE:
    log.warning("SSO เปิดใช้แล้ว — ACCESS_CODE ถูกปิดตามกติกา C9 (ลบ env ACCESS_CODE ออกได้เลย)")
    ACCESS_CODE = ""
CHECK_MAX_AGE = int(os.environ.get("CHECK_MAX_AGE_SEC", "900"))        # ผลตรวจสดใช้ได้ ≤15 นาที (C4) — ย่อได้ตอนเทส
SESSION_MAX_SEC = int(os.environ.get("SESSION_MAX_SEC", str(12 * 3600)))  # เพดาน session 12 ชม. (C3)
FULL_SSO_WINDOW = int(os.environ.get("FULL_SSO_WINDOW_SEC", "300"))    # การกระทำระดับ full ต้องแลกตั๋วมาไม่เกินกี่วินาที (re-SSO)
HTTP_TIMEOUT = float(os.environ.get("SSO_HTTP_TIMEOUT_SEC", "10"))

_central_down_since = None   # เวลาเริ่มยิงบ้านกลางไม่ติด (ใช้เตือนเกณฑ์ 30 นาที ข้อ C5)
_central_down_alerted = False


def _now():
    return datetime.datetime.utcnow()


def _iso(dt=None):
    return (dt or _now()).isoformat()


def _parse_iso(s):
    """รับ ISO string ทั้งแบบมี timezone (เช่น '...Z' จากบ้านกลาง) และแบบ naive —
    คืนเป็น naive UTC เสมอ ให้เทียบกับ _now() ได้ (เทียบ aware กับ naive = TypeError → 500)"""
    try:
        dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return dt


def _central_post(path: str, payload: dict):
    """ยิงบ้านกลาง — คืน (status_code, json|None) · ยิงไม่ติด/ผิดพลาดเครือข่าย = (None, None) = บ้านกลางขัดข้อง (C5)"""
    global _central_down_since, _central_down_alerted
    import httpx
    try:
        r = httpx.post(BBT_URL + path, json=payload, timeout=HTTP_TIMEOUT,
                       headers={"Authorization": "Bearer " + HOUSE_KEY})
        if r.status_code >= 500:
            raise RuntimeError(f"central 5xx: {r.status_code}")
        _central_down_since = None
        _central_down_alerted = False
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, None
    except Exception as e:
        if _central_down_since is None:
            _central_down_since = _now()
            log.warning("บ้านกลางขัดข้อง (%s) — เริ่มนับเวลา ณ %s", e, _iso(_central_down_since))
        elif not _central_down_alerted and (_now() - _central_down_since).total_seconds() > 30 * 60:
            _central_down_alerted = True
            log.error("⚠ บ้านกลางเงียบเกิน 30 นาที (ตั้งแต่ %s) — เข้าเกณฑ์เหตุร้ายแรงข้อ 7: "
                      "เจ้าของบ้านต้องแจ้ง Meth ผ่านห้องทีม dev บน Discord", _iso(_central_down_since))
        return None, None


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _load_session(request: Request):
    token = request.cookies.get("bbt_session", "")
    if not token:
        return None
    with engine.begin() as con:
        con.execute(delete(sessions).where(sessions.c.expires_at < _iso()))   # ล้าง session หมดอายุแบบ lazy
        row = con.execute(select(sessions).where(sessions.c.token_hash == _token_hash(token))).fetchone()
    return dict(row._mapping) if row else None


def _delete_session(token_hash: str):
    with engine.begin() as con:
        con.execute(delete(sessions).where(sessions.c.token_hash == token_hash))


def _ensure_fresh(sess: dict, force: bool = False):
    """ให้ผลตรวจสดอายุ ≤ CHECK_MAX_AGE (C4) — คืน (ok, reason)
    reason เมื่อไม่ ok: badge_invalid|badge_expired|disabled|no_permission (จบ session)
                     · central_down|central_rate_limited|house_key_error (session คงอยู่ แต่ห้ามเปิดข้อมูลใหม่/เขียน — C5)"""
    last = _parse_iso(sess.get("last_check_at"))
    if not force and last and (_now() - last).total_seconds() <= CHECK_MAX_AGE:
        return True, None
    status, body = _central_post("/api/auth/sso/check", {"house": HOUSE_SLUG, "badge": sess["badge"]})
    if status is None:
        return False, "central_down"
    if status == 429:
        return False, "central_rate_limited"
    if status == 401:
        # กุญแจเข้าบ้านไม่ผ่าน — ปัญหา config ฝั่งเรา ห้ามวนยิงซ้ำ (C2/C4)
        log.error("check ตอบ 401 — ตรวจ env HOUSE_KEY (ยิงผิด ≥5 ครั้ง/5 นาที จะโดนพัก 429 + เข้าเกณฑ์เหตุร้ายแรง)")
        return False, "house_key_error"
    if status == 200 and isinstance(body, dict):
        if body.get("ok"):
            with engine.begin() as con:
                con.execute(update(sessions).where(sessions.c.token_hash == sess["token_hash"])
                            .values(role=body.get("role", sess["role"]), last_check_at=_iso()))
            sess["role"] = body.get("role", sess["role"])
            sess["last_check_at"] = _iso()
            _upsert_user(json.loads(sess["user_json"]), sess["role"])
            return True, None
        reason = body.get("reason", "badge_invalid")
        _delete_session(sess["token_hash"])       # ok:false ทุก reason = ตัดการเข้าถึงทันที (C4)
        return False, reason
    return False, "central_down"


def _upsert_user(u: dict, role: str):
    uid = str(u.get("id", ""))
    if not uid:
        return
    now = _iso()
    with engine.begin() as con:
        exists = con.execute(select(users.c.central_user_id).where(users.c.central_user_id == uid)).fetchone()
        vals = dict(display_name=str(u.get("display_name") or ""), last_role=str(role or ""), updated_at=now)
        if exists:
            con.execute(update(users).where(users.c.central_user_id == uid).values(**vals))
        else:
            con.execute(insert(users).values(central_user_id=uid, **vals))


def _session_public(sess: dict):
    """ข้อมูล session ที่ปล่อยให้ browser เห็นได้ — ไม่มีบัตร (badge) เด็ดขาด (C3)"""
    return {
        "ok": True,
        "user": json.loads(sess["user_json"]),
        "role": sess["role"],
        "sso_at": sess["sso_at"],
        "checked_at": sess["last_check_at"],
        "session_expires_at": sess["expires_at"],
    }

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(HERE, "..", "index.html")    # แหล่งเดียวกับโหมดออฟไลน์ — ไม่มีสำเนา


def _index_html() -> str:
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        html = f.read()
    # เปิดโหมด REMOTE ให้ frontend เก็บข้อมูลผ่าน API แทน localStorage/Firebase (+ ค่า SSO เมื่อเปิดใช้)
    inject = "<script>window.__BBT_REMOTE=true;window.__API_BASE='';"
    if SSO_ENABLED:
        inject += ("window.__BBT_SSO=true;"
                   f"window.__BBT_HOME={json.dumps(BBT_URL)};"
                   f"window.__BBT_GATE={json.dumps(BBT_URL + '/api/sso/' + HOUSE_SLUG)};"
                   f"window.__BBT_CHECK_AGE={CHECK_MAX_AGE};"
                   f"window.__BBT_FULL_WINDOW={FULL_SSO_WINDOW};")
    inject += "</script>"
    return html.replace("<body>", "<body>\n" + inject, 1)


GATE_HTML = """<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ภ.ง.ด.51 — เข้าสู่ระบบ</title>
<style>body{font-family:-apple-system,'Sarabun',sans-serif;background:#f2f2f7;display:flex;min-height:100vh;
align-items:center;justify-content:center;margin:0}form{background:#fff;padding:28px;border-radius:16px;
box-shadow:0 4px 16px rgba(0,0,0,.08);width:320px}h1{font-size:20px;margin:0 0 4px}p{color:#8e8e93;font-size:14px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e5e5ea;border-radius:12px;font-size:15px}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:12px;background:#6fae2b;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#ff3b30;font-size:13px;margin-top:8px}</style></head>
<body><form method="get" action="/gate"><h1>ภ.ง.ด.51 (BBT)</h1>
<p>กรอกรหัสเข้าใช้งาน</p><input type="password" name="code" placeholder="รหัสเข้าใช้งาน" autofocus>
<button type="submit">เข้าสู่ระบบ</button>__ERR__</form></body></html>"""


def _authorized(request: Request) -> bool:
    if not ACCESS_CODE:
        return True
    return request.cookies.get("bbt_access") == ACCESS_CODE


ROLE_ORDER = {"viewer": 0, "editor": 1, "full": 2}


def _role_at_least(role: str, need: str) -> bool:
    return ROLE_ORDER.get(role, -1) >= ROLE_ORDER.get(need, 99)


def _sso_fresh_for_full(sess: dict) -> bool:
    """การกระทำระดับ full ต้องเพิ่งผ่านประตูบ้านกลางมา (re-SSO) ไม่เกิน FULL_SSO_WINDOW วินาที (C4)"""
    at = _parse_iso(sess.get("sso_at"))
    return bool(at and (_now() - at).total_seconds() <= FULL_SSO_WINDOW)


@app.middleware("http")
async def gate_middleware(request: Request, call_next):
    path = request.url.path
    if SSO_ENABLED:
        # หน้า shell (/) เสิร์ฟได้เสมอ — ไม่มีข้อมูล · JS ในหน้าจะจัดการตั๋ว/พาไปประตูเอง
        if path == "/" or path == "/api/health" or path == "/api/sso/login":
            return await call_next(request)
        if path.startswith("/api"):
            sess = _load_session(request)
            if not sess:
                return JSONResponse({"error": "no_session"}, status_code=401)
            ok, reason = _ensure_fresh(sess)
            if not ok:
                if reason in ("badge_invalid", "badge_expired"):
                    return JSONResponse({"error": reason}, status_code=401)      # → ผ่านประตูใหม่
                if reason in ("disabled", "no_permission"):
                    return JSONResponse({"error": reason}, status_code=403)      # จบ session แสดงเหตุผล
                return JSONResponse({"error": reason}, status_code=503)          # บ้านกลางขัดข้อง/กุญแจ — C5
            # role gating ฝั่ง API (สิทธิ์จากผลตรวจสดเท่านั้น — C6) — viewer เขียนอะไรไม่ได้เลย
            if request.method in ("PUT", "POST", "DELETE") and not path.startswith("/api/sso/"):
                if not _role_at_least(sess["role"], "editor"):
                    return JSONResponse({"error": "role_viewer"}, status_code=403)
                # ลบบริษัท = ระดับ full + ต้องเพิ่ง re-SSO (การทำลายข้อมูลถาวร)
                if request.method == "DELETE" and path.startswith("/api/companies"):
                    if not _role_at_least(sess["role"], "full"):
                        return JSONResponse({"error": "need_full"}, status_code=403)
                    if not _sso_fresh_for_full(sess):
                        return JSONResponse({"error": "need_resso"}, status_code=403)
            request.state.sess = sess
            resp = await call_next(request)
            # ให้ frontend จับเวลาล็อกจอจากผลตรวจจริง (ไม่มี heartbeat — header มากับ request ที่ผู้ใช้ทำเอง)
            resp.headers["X-SSO-Checked-At"] = str(sess.get("last_check_at", ""))
            resp.headers["X-SSO-Role"] = str(sess.get("role", ""))
            return resp
        return await call_next(request)
    # โหมดเดิม: ACCESS_CODE รวมหนึ่งรหัส (ชั่วคราว — ปิดเมื่อ SSO ขึ้นจริง)
    # /api/health เปิด public เสมอ (ไม่มีข้อมูลลับ) — Render ใช้เป็น health check ถ้าบล็อกจะ deploy ไม่ผ่าน
    if ACCESS_CODE and path not in ("/gate", "/api/health") and not _authorized(request):
        if path.startswith("/api"):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return HTMLResponse(GATE_HTML.replace("__ERR__", ""), status_code=401)
    return await call_next(request)


@app.get("/gate")
def gate(code: str = ""):
    if code == ACCESS_CODE and ACCESS_CODE:
        resp = RedirectResponse("/", status_code=302)
        resp.set_cookie("bbt_access", ACCESS_CODE, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 30)
        return resp
    return HTMLResponse(GATE_HTML.replace("__ERR__", '<div class="err">รหัสไม่ถูกต้อง</div>'), status_code=401)


@app.get("/", response_class=HTMLResponse)
def home():
    return HTMLResponse(_index_html())


@app.get("/api/health")
def health():
    out = {"ok": True, "db": DATABASE_URL.split(":")[0], "access_code": bool(ACCESS_CODE), "sso": SSO_ENABLED}
    if SSO_ENABLED and _central_down_since is not None:
        out["central_down_since"] = _iso(_central_down_since)   # เกิน 30 นาที = แจ้ง Meth ผ่าน Discord (C5 ข้อ 7)
    return out


# ---------- SSO endpoints (ฝั่งบ้าน) ----------
@app.post("/api/sso/login")
async def sso_login(request: Request, response: Response):
    """รับตั๋วจากหน้าเว็บ (POST body เท่านั้น — C1) → แลกบัตรกับบ้านกลาง → เปิด session ของบ้าน
    กติกาเหล็ก C2: exchange ไม่ได้ 200 ไม่ว่าเหตุใด = ทิ้งตั๋วถาวร ห้าม retry — เราไม่เก็บตั๋วไว้ จบในคำขอนี้"""
    if not SSO_ENABLED:
        raise HTTPException(404)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    ticket = str((body or {}).get("ticket", "")).strip()
    if not ticket:
        raise HTTPException(400, "no ticket")
    status, data = _central_post("/api/auth/sso/exchange", {"house": HOUSE_SLUG, "ticket": ticket})
    if status is None:
        return JSONResponse({"error": "central_down"}, status_code=503)
    if status == 429:
        return JSONResponse({"error": "central_rate_limited"}, status_code=503)
    if status == 401:
        # ตั๋ว/กุญแจไม่ผ่าน — frontend พาผู้ใช้ผ่านประตูใหม่ · ถ้าใบใหม่ก็ยัง 401 = ปัญหากุญแจ ให้หยุดวน (C2)
        return JSONResponse({"error": "ticket_rejected"}, status_code=401)
    if status == 403:
        return JSONResponse({"error": "no_permission"}, status_code=403)
    if status != 200 or not isinstance(data, dict) or not data.get("ok") or not data.get("badge"):
        return JSONResponse({"error": "central_down"}, status_code=503)

    user = data.get("user") or {}
    now = _now()
    exp = now + datetime.timedelta(seconds=SESSION_MAX_SEC)
    badge_exp = _parse_iso(data.get("badge_expires_at"))
    if badge_exp and badge_exp < exp:
        exp = badge_exp                                    # session ไม่เกินอายุบัตร (C3)
    token = secrets.token_urlsafe(32)
    sess = dict(token_hash=_token_hash(token), badge=str(data["badge"]),
                badge_expires_at=str(data.get("badge_expires_at") or ""),
                user_json=json.dumps({"id": user.get("id"), "display_name": user.get("display_name"),
                                      "full_name": user.get("full_name"), "initial": user.get("initial")},
                                     ensure_ascii=False),
                role=str(data.get("role", "viewer")), sso_at=_iso(now), last_check_at=_iso(now),
                expires_at=_iso(exp))
    with engine.begin() as con:
        con.execute(insert(sessions).values(**sess))
    _upsert_user(user, sess["role"])
    response.set_cookie("bbt_session", token, httponly=True, samesite="lax",
                        secure=(request.url.scheme == "https"), max_age=SESSION_MAX_SEC)
    return _session_public(sess)


@app.get("/api/sso/me")
def sso_me(request: Request):
    return _session_public(request.state.sess)     # middleware ตรวจความสดให้แล้ว


@app.post("/api/sso/refresh")
def sso_refresh(request: Request):
    """ตรวจสถานะกับบ้านกลางเดี๋ยวนี้ (ผู้ใช้กดปลดล็อกจอเอง — ไม่มี heartbeat อัตโนมัติ)"""
    sess = request.state.sess
    ok, reason = _ensure_fresh(sess, force=True)
    if not ok:
        if reason in ("badge_invalid", "badge_expired"):
            return JSONResponse({"error": reason}, status_code=401)
        if reason in ("disabled", "no_permission"):
            return JSONResponse({"error": reason}, status_code=403)
        return JSONResponse({"error": reason}, status_code=503)
    return _session_public(sess)


# ---------- ข้อมูลบริษัท (แทน Firestore ของโหมด Firebase เดิม) ----------
def _tombs_dict(con) -> dict:
    return {r.id: {"del": int(r.del_at or 0), "undel": int(r.undel_at or 0)}
            for r in con.execute(select(tombs)).fetchall()}


def _is_deleted(t: dict) -> bool:
    return (t.get("del") or 0) > (t.get("undel") or 0)


def _merge_tomb(con, cid: str, del_at=0, undel_at=0):
    """รวมด้วยค่ามากสุดของแต่ละช่อง — สลับลำดับ/รวมกี่รอบผลเท่ากัน (กติกาเดียวกับ mergeTombs ฝั่งแอป)"""
    row = con.execute(select(tombs).where(tombs.c.id == cid)).fetchone()
    if row:
        con.execute(update(tombs).where(tombs.c.id == cid).values(
            del_at=str(max(int(row.del_at or 0), int(del_at or 0))),
            undel_at=str(max(int(row.undel_at or 0), int(undel_at or 0)))))
    else:
        con.execute(insert(tombs).values(id=cid, del_at=str(int(del_at or 0)), undel_at=str(int(undel_at or 0))))


# บทบาทบ้านกลาง → บทบาทธรรมชาติของบ้านนี้ (เสนอโดยล้อมติ Lead Sheet 15 ส.ค. — รอ Meth เคาะใน SSO-HOUSE.md):
#   viewer = ดูอย่างเดียว · editor = จัดทำ+ตรวจ (ส่งตรวจ/ผ่านตรวจ/ส่งอนุมัติ/ตีกลับ/บันทึกยื่น-ชำระ)
#   full   = อนุมัติ/ตีกลับหลังส่งอนุมัติ/เปิดแก้ไขใหม่/ลบบริษัท — และการอนุมัติต้อง re-SSO ก่อนทุกครั้ง (C4)
ROLE_TO_RTYPE = {"editor": "manager", "full": "partner"}    # ให้ dropdown ผู้รับผิดชอบเดิมกรองได้ · viewer ไม่เข้า roster


def _employees_list(con):
    rows = con.execute(select(users)).fetchall()
    out = []
    for r in rows:
        rt = ROLE_TO_RTYPE.get(r.last_role)
        if not rt:
            continue                       # viewer/ไม่ทราบ role — ไม่อยู่ในรายชื่อผู้รับผิดชอบ
        out.append({"name": r.display_name or r.central_user_id, "role": "", "rtype": rt,
                    "uid": r.central_user_id, "src": "central"})
    out.sort(key=lambda e: e["name"])
    return out


@app.get("/api/data")
def get_data():
    """ชุดข้อมูลทั้งบ้านในคำขอเดียว — แอปดึงตอนเปิด/ปลดล็อก/กดซิงค์ (ไม่มี realtime — C4 ห้าม traffic อัตโนมัติ)"""
    with engine.connect() as con:
        t = _tombs_dict(con)
        rows = con.execute(select(companies.c.data)).fetchall()
        emps = _employees_list(con)
    comp = []
    for (data,) in rows:
        try:
            obj = json.loads(data)
        except Exception:
            continue
        if not _is_deleted(t.get(obj.get("id"), {})):
            comp.append(obj)
    return JSONResponse({"companies": comp, "tombs": t, "employees": emps})


# การเปลี่ยนสถานะ workflow ระดับ full: อนุมัติ · ตีกลับหลังส่งอนุมัติ · เปิดแก้ไขใหม่หลังอนุมัติ/ยื่น/เสร็จ
def _wf_status(obj: dict) -> str:
    wf = obj.get("workflow") if isinstance(obj.get("workflow"), dict) else {}
    return str(wf.get("status") or "draft")


def _full_transition(old_status: str, new_status: str) -> bool:
    if old_status == new_status:
        return False
    if new_status == "approved":
        return True                                          # อนุมัติ (ลายเซ็นผู้อนุมัติ)
    if old_status == "reviewed" and new_status == "draft":
        return True                                          # ตีกลับหลังส่งอนุมัติ (การตัดสินของผู้อนุมัติ)
    if old_status in ("approved", "filed", "completed") and new_status == "draft":
        return True                                          # เปิดแก้ไขใหม่ = ถอนการอนุมัติ/การยื่นที่บันทึกแล้ว
    return False


def _approver_sig(obj: dict):
    wf = obj.get("workflow") if isinstance(obj.get("workflow"), dict) else {}
    cur = wf.get("current") if isinstance(wf.get("current"), dict) else {}
    ap = cur.get("approver") if isinstance(cur.get("approver"), dict) else {}
    return (ap.get("name"), ap.get("at"))


def _stamp_signer(obj: dict, old_status: str, new_status: str, sess: dict):
    """ใครกด คนนั้นเซ็น — ประทับตัวตนจากบัญชีที่ล็อกอินทับค่าที่ browser ส่งมา (browser แก้เองไม่ได้)"""
    u = json.loads(sess["user_json"])
    ident = {"name": u.get("display_name") or str(u.get("id") or ""), "at": _iso() + "Z",
             "by": {"uid": u.get("id")}}
    wf = obj.setdefault("workflow", {})
    cur = wf.setdefault("current", {})
    if old_status == "draft" and new_status == "submitted":
        cur["preparer"] = ident
    elif old_status == "submitted" and new_status == "checked":
        cur["reviewer"] = ident
    elif new_status == "approved":
        cur["approver"] = ident


@app.put("/api/companies/{cid}")
async def upsert_company(cid: str, request: Request):
    body = await request.body()
    try:
        obj = json.loads(body)
    except Exception:
        raise HTTPException(400, "invalid JSON")
    if not isinstance(obj, dict):
        raise HTTPException(400, "company must be an object")
    obj["id"] = cid  # id ใน URL คือความจริง
    with engine.connect() as con:
        old = con.execute(select(companies.c.data).where(companies.c.id == cid)).fetchone()
    old_obj = {}
    if old:
        try:
            old_obj = json.loads(old[0])
        except Exception:
            old_obj = {}
    old_st, new_st = _wf_status(old_obj), _wf_status(obj)
    if SSO_ENABLED:
        sess = request.state.sess
        # อนุมัติ/ถอนอนุมัติ หรือแก้ลายเซ็นผู้อนุมัติ = ระดับ full + ต้องเพิ่งผ่านประตูมา (re-SSO — C4)
        if _full_transition(old_st, new_st) or (old and _approver_sig(obj) != _approver_sig(old_obj)):
            if not _role_at_least(sess["role"], "full"):
                return JSONResponse({"error": "need_full"}, status_code=403)
            if not _sso_fresh_for_full(sess):
                return JSONResponse({"error": "need_resso"}, status_code=403)
        if old_st != new_st:
            _stamp_signer(obj, old_st, new_st, sess)
    name = str(obj.get("name", ""))
    now = _iso()
    payload = json.dumps(obj, ensure_ascii=False)
    with engine.begin() as con:
        # เขียนบริษัทที่เคยลบ = ตั้งใจเอากลับมา (เช่น import) → ยกเลิก tombstone
        t = _tombs_dict(con).get(cid, {})
        if _is_deleted(t):
            _merge_tomb(con, cid, undel_at=int(_now().timestamp() * 1000))
        exists = con.execute(select(companies.c.id).where(companies.c.id == cid)).fetchone()
        if exists:
            con.execute(update(companies).where(companies.c.id == cid)
                        .values(name=name, data=payload, updated_at=now))
        else:
            con.execute(insert(companies).values(id=cid, name=name, data=payload, updated_at=now))
    return {"ok": True}


@app.delete("/api/companies/{cid}")
def delete_company(cid: str):
    """ลบถาวร + จด tombstone — middleware บังคับ full + re-SSO แล้ว (ตอน SSO เปิด)"""
    with engine.begin() as con:
        con.execute(delete(companies).where(companies.c.id == cid))
        _merge_tomb(con, cid, del_at=int(_now().timestamp() * 1000))
    return {"ok": True}


@app.put("/api/tombs")
async def put_tombs(request: Request):
    """รวม tombstone จากเครื่องผู้ใช้ (เช่น import ไฟล์ที่เคยลบ → undel) — max ต่อช่อง เหมือน mergeTombs"""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "expected {id: {del, undel}}")
    with engine.begin() as con:
        for cid, t in body.items():
            if not isinstance(t, dict) or not str(cid).strip():
                continue
            _merge_tomb(con, str(cid)[:64], del_at=t.get("del") or 0, undel_at=t.get("undel") or 0)
        out = _tombs_dict(con)
    return JSONResponse(out)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
