/* ============================================================================
 *  neon-client.js — ชั้นเชื่อมต่อ "ระบบกลาง" กับ Neon (แทนที่ Firebase/Firestore)
 *
 *  ใช้ได้ทั้งในเบราว์เซอร์ (แนบเป็น window.NeonSync) และใน Node (module.exports)
 *  เพื่อให้ทดสอบตรรกะ mapping/sync นอกเบราว์เซอร์ได้
 *
 *  ประกอบด้วย 3 ส่วน:
 *    1) mapping     — แปลงระหว่าง "อ็อบเจกต์บริษัทของแอป" กับ "แถวในตาราง company"
 *    2) data (REST) — คุยกับ Neon Data API (PostgREST) โดยแนบ JWT ที่ได้จาก auth
 *    3) auth        — ล็อกอิน/สมัคร/รีเฟรชโทเคน ผ่าน Neon Auth (Stack Auth) REST
 *
 *  ความปลอดภัยทั้งหมดอยู่ที่ RLS ใน neon/schema.sql — ชั้นนี้แค่เรียก API ให้ถูก
 * ========================================================================== */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;      // Node
  else root.NeonSync = mod;                                                        // browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 1) mapping: app company object <-> DB row ----------
  const asObj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const asArr = v => Array.isArray(v) ? v : null;

  function companyToRow(c) {
    return {
      id: c.id,
      name: c.name || '',
      tax_id: c.taxId || '',
      fiscal_year: parseInt(c.year, 10) || null,
      job_code: c.jobCode || '',
      year_end: c.yearEnd || '',
      entity_type: c.entityType === 'general' ? 'general' : 'sme',
      status: (c.workflow && c.workflow.status) || 'draft',
      preparer: c.preparer || '',
      reviewer: c.reviewer || '',
      approver: c.approver || '',
      est: asObj(c.est),
      tb: asObj(c.tb),
      history: asArr(c.history) || [],
      loss_carry: asArr(c.lossCarry) || [0, 0, 0, 0, 0],
      prior_year_tax: asObj(c.priorYearTax),
      workflow: asObj(c.workflow)
      // ห้ามส่ง created_/updated_/timestamps — เซิร์ฟเวอร์คุมเองผ่าน trigger
    };
  }

  function rowToCompany(r) {
    const c = {
      id: r.id,
      name: r.name || '',
      taxId: r.tax_id || '',
      year: r.fiscal_year || '',
      jobCode: r.job_code || '',
      yearEnd: r.year_end || '',
      entityType: r.entity_type === 'general' ? 'general' : 'sme',
      preparer: r.preparer || '',
      reviewer: r.reviewer || '',
      approver: r.approver || '',
      est: asObj(r.est),
      tb: asObj(r.tb),
      history: asArr(r.history) || [],
      lossCarry: asArr(r.loss_carry) || [0, 0, 0, 0, 0],
      priorYearTax: asObj(r.prior_year_tax),
      workflow: asObj(r.workflow),
      // เมตาการซิงค์: ใช้เวลาเซิร์ฟเวอร์ (updated_at) แทนนาฬิกาเครื่อง — ไม่มีปัญหานาฬิกาเพี้ยนอีก
      _syncAt: r.updated_at ? Date.parse(r.updated_at) : 0,
      _deletedAt: r.deleted_at ? Date.parse(r.deleted_at) : 0,
      _undeletedAt: r.undeleted_at ? Date.parse(r.undeleted_at) : 0
    };
    return c;
  }
  // บริษัทถูกลบอยู่ไหม (soft delete) — แทน tombstone list ทั้งชุด
  function rowIsDeleted(r) {
    const d = r.deleted_at ? Date.parse(r.deleted_at) : 0;
    const u = r.undeleted_at ? Date.parse(r.undeleted_at) : 0;
    return d > 0 && d > u;
  }

  // คอลัมน์ที่ client มีสิทธิ์เขียน (ใช้ตอนหาว่าอะไรเปลี่ยนเพื่อ PATCH เฉพาะช่องนั้น)
  const WRITABLE_COLS = ['name', 'tax_id', 'fiscal_year', 'job_code', 'year_end',
    'entity_type', 'status', 'preparer', 'reviewer', 'approver',
    'est', 'tb', 'history', 'loss_carry', 'prior_year_tax', 'workflow'];

  // เทียบค่าแบบไม่สนลำดับคีย์ของอ็อบเจกต์ — สำคัญมาก เพราะ Postgres คืนค่า jsonb โดย "เรียงคีย์ใหม่"
  // ถ้าเทียบด้วย JSON.stringify ตรง ๆ จะเห็นเป็น "เปลี่ยน" ทั้งที่เนื้อหาเท่าเดิม แล้วไป PATCH ทับงานคนอื่น
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  // เทียบแถวใหม่กับแถวที่เซิร์ฟเวอร์มีอยู่ คืนเฉพาะคอลัมน์ที่ต่างจริง
  // → PATCH แค่คอลัมน์ที่เปลี่ยน ทำให้คนละคนแก้คนละส่วนพร้อมกันไม่ทับกัน
  function changedColumns(newRow, prevRow) {
    if (!prevRow) return null;                       // ไม่มีฐานเทียบ → เขียนทั้งแถว (upsert)
    const patch = {};
    let n = 0;
    for (const k of WRITABLE_COLS) {
      if (stable(newRow[k]) !== stable(prevRow[k])) { patch[k] = newRow[k]; n++; }
    }
    return n ? patch : null;                          // null = ไม่มีอะไรเปลี่ยน ไม่ต้องส่ง
  }

  // ---------- 2) data: Neon Data API (PostgREST) ----------
  // cfg = { dataApiUrl, getToken: async () => '<jwt>' | null }
  function makeData(cfg) {
    const base = String(cfg.dataApiUrl || '').replace(/\/+$/, '');
    async function api(method, path, { body, prefer } = {}) {
      const token = cfg.getToken ? await cfg.getToken() : null;
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      if (prefer) headers.Prefer = prefer;
      const res = await fetch(base + path, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
      if (!res.ok) {
        const msg = (data && data.message) || res.status + ' ' + res.statusText;
        const err = new Error(msg); err.status = res.status; err.body = data; throw err;
      }
      return data;
    }

    return {
      _api: api,
      // ---- companies ----
      async listCompanies() {
        const rows = await api('GET', '/company?select=*');
        return (rows || []).map(r => ({ company: rowToCompany(r), row: r, deleted: rowIsDeleted(r) }));
      },
      // upsert แบบ field-merge: ใหม่ = POST ทั้งแถว · มีอยู่แล้ว = PATCH เฉพาะช่องที่เปลี่ยน
      async saveCompany(company, prevRow) {
        const newRow = companyToRow(company);
        if (!prevRow) {
          const out = await api('POST', '/company', {
            body: newRow, prefer: 'return=representation,resolution=merge-duplicates'
          });
          return Array.isArray(out) ? out[0] : out;
        }
        const patch = changedColumns(newRow, prevRow);
        if (!patch) return prevRow;                    // ไม่มีอะไรเปลี่ยน
        const out = await api('PATCH', '/company?id=eq.' + encodeURIComponent(company.id),
          { body: patch, prefer: 'return=representation' });
        return Array.isArray(out) ? out[0] : out;
      },
      async softDelete(id) {
        const out = await api('PATCH', '/company?id=eq.' + encodeURIComponent(id),
          { body: { deleted_at: new Date().toISOString() }, prefer: 'return=representation' });
        return Array.isArray(out) ? out[0] : out;
      },
      async undelete(id) {
        const out = await api('PATCH', '/company?id=eq.' + encodeURIComponent(id),
          { body: { undeleted_at: new Date().toISOString() }, prefer: 'return=representation' });
        return Array.isArray(out) ? out[0] : out;
      },
      async hardDelete(id) {                            // manager+ เท่านั้น (RLS คุม)
        await api('DELETE', '/company?id=eq.' + encodeURIComponent(id));
      },
      // ---- users / โปรไฟล์ + อนุมัติ ----
      async listApprovedUsers() {
        return await api('GET', '/app_user?approved=eq.true&select=uid,email,name,role');
      },
      async listPendingUsers() {
        return await api('GET', '/app_user?approved=eq.false&rejected=eq.false&select=uid,email,name');
      },
      async getMyProfile(uid) {
        const r = await api('GET', '/app_user?uid=eq.' + encodeURIComponent(uid) + '&select=*');
        return (r && r[0]) || null;
      },
      // สร้างคำขอรออนุมัติของตัวเอง (RLS บังคับ approved=false, role=staff อยู่แล้ว)
      async createOwnProfile(uid, email, name) {
        try {
          await api('POST', '/app_user', {
            body: { uid, email: email || '', name: name || '', approved: false, rejected: false, role: 'staff' },
            prefer: 'resolution=ignore-duplicates'
          });
        } catch (e) { if (e.status !== 409) throw e; }
      },
      async approveUser(uid, role, byEmail) {
        await api('PATCH', '/app_user?uid=eq.' + encodeURIComponent(uid),
          { body: { approved: true, rejected: false, role, approved_by: byEmail || '', approved_at: new Date().toISOString() } });
      },
      async setUserRole(uid, role) {
        await api('PATCH', '/app_user?uid=eq.' + encodeURIComponent(uid), { body: { role } });
      },
      async rejectUser(uid, byEmail) {
        await api('PATCH', '/app_user?uid=eq.' + encodeURIComponent(uid),
          { body: { approved: false, rejected: true, role: 'staff' } });
      }
    };
  }

  // ---------- 3) auth: Neon Auth (Stack Auth) REST ----------
  // authCfg = { authBaseUrl, projectId, publishableKey }
  //   ค่าเหล่านี้เอามาจากแดชบอร์ด Neon → Auth (Neon Auth ใช้ Stack Auth อยู่เบื้องหลัง)
  //   เก็บ access/refresh token ไว้ใน localStorage แล้วรีเฟรชอัตโนมัติเมื่อใกล้หมดอายุ
  function makeAuth(authCfg, storage) {
    const base = String(authCfg.authBaseUrl || 'https://api.stack-auth.com').replace(/\/+$/, '');
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : memStore());
    const KEY = 'neon_auth_tokens_v1';
    const headersBase = () => ({
      'Content-Type': 'application/json',
      'X-Stack-Access-Type': 'client',
      'X-Stack-Project-Id': authCfg.projectId,
      'X-Stack-Publishable-Client-Key': authCfg.publishableKey
    });
    const getTokens = () => { try { return JSON.parse(store.getItem(KEY) || 'null'); } catch (e) { return null; } };
    const setTokens = t => { try { t ? store.setItem(KEY, JSON.stringify(t)) : store.removeItem(KEY); } catch (e) {} };

    async function call(path, body, extraHeaders) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: Object.assign(headersBase(), extraHeaders || {}),
        body: JSON.stringify(body || {})
      });
      const text = await res.text();
      let data = null; if (text) { try { data = JSON.parse(text); } catch (e) {} }
      if (!res.ok) {
        const err = new Error((data && (data.message || data.error)) || ('auth ' + res.status));
        err.status = res.status; err.code = data && data.code; err.body = data; throw err;
      }
      return data;
    }

    return {
      _store: store,
      getTokens,
      isSignedIn: () => !!(getTokens() && getTokens().refresh_token),
      async signUp(email, password, displayName) {
        // สมัคร แล้ว sign-in ต่อเพื่อได้โทเคนทันที (Stack Auth แยก endpoint)
        await call('/api/v1/auth/password/sign-up', {
          email, password, verification_callback_url: (typeof location !== 'undefined' ? location.href : '')
        });
        if (displayName) { /* ตั้งชื่อหลัง sign-in ผ่าน /api/v1/users/me */ }
        return this.signIn(email, password, displayName);
      },
      async signIn(email, password, displayName) {
        const t = await call('/api/v1/auth/password/sign-in', { email, password });
        setTokens({ access_token: t.access_token, refresh_token: t.refresh_token, at: Date.now() });
        if (displayName) { try { await this.setDisplayName(displayName); } catch (e) {} }
        return t;
      },
      async setDisplayName(name) {
        const tk = getTokens(); if (!tk) return;
        await call('/api/v1/users/me', { display_name: name }, { 'X-Stack-Access-Token': tk.access_token });
      },
      async refresh() {
        const tk = getTokens();
        if (!tk || !tk.refresh_token) return null;
        const t = await call('/api/v1/auth/sessions/current/refresh', {}, { 'X-Stack-Refresh-Token': tk.refresh_token });
        const next = { access_token: t.access_token, refresh_token: tk.refresh_token, at: Date.now() };
        setTokens(next);
        return next.access_token;
      },
      // token ที่แนบไปกับ Data API — รีเฟรชถ้าเก่ากว่า ~40 นาที (อายุปกติ 1 ชม.)
      async getAccessToken() {
        const tk = getTokens();
        if (!tk) return null;
        if (!tk.access_token || (Date.now() - (tk.at || 0)) > 40 * 60 * 1000) {
          try { return await this.refresh(); } catch (e) { return tk.access_token || null; }
        }
        return tk.access_token;
      },
      signOut() { setTokens(null); }
    };
  }

  function memStore() {
    const m = {};
    return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
  }

  return {
    companyToRow, rowToCompany, rowIsDeleted, changedColumns, WRITABLE_COLS,
    makeData, makeAuth, memStore
  };
});
