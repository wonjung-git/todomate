// todo mate — Cloudflare Worker
// Serves the SPA (static assets under ./public) and a tiny sync API backed by D1.
//
// API:
//   GET  /api/state   -> { data, updated }      (data is null if nothing stored yet)
//   PUT  /api/state   body { data, updated }     -> { ok:true, updated }
//
// Auth: header  Authorization: Bearer <sync-code>
//   The sync code is both the identity and the password: the row id is
//   sha256("todomate:" + code), so a different code = a different, private space.
//   Data is stored last-write-wins by the `updated` timestamp.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request); // everything else -> static files (index.html, etc.)
  },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// KST (UTC+9) date as YYYY-MM-DD
function kstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

// Mirror of the app's "items for a day": routines (Mon-first, within range) + todos, minus archived.
function computeDay(st, date) {
  if (!st) return [];
  const cats = st.categories || [];
  const map = Object.fromEntries(cats.map((c) => [c.id, c]));
  const wd = (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
  const rd = st.routineDone || {};
  const out = [];
  (st.routines || []).forEach((r) => {
    if (r.manual) return;
    if (!(r.days || []).includes(wd)) return;
    if (r.start && date < r.start) return;
    if (r.end && date > r.end) return;
    const c = map[r.catId] || {};
    out.push({ title: r.title, cat: c.name || "", color: c.color || "#888", time: r.time || "", done: !!rd[r.id + "|" + date], key: "r:" + r.id });
  });
  (st.todos || []).forEach((t) => {
    if (t.date !== date || t.archived) return;
    const c = map[t.catId] || {};
    out.push({ title: t.title, cat: c.name || "", color: c.color || "#888", time: t.time || "", done: !!t.done, key: "t:" + t.id });
  });
  out.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
  return out;
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!env.DB) return json({ error: "D1 binding 'DB' is not configured" }, 500);

  const auth = request.headers.get("Authorization") || "";
  let code = auth.replace(/^Bearer\s+/i, "").trim();
  if (!code) code = (url.searchParams.get("key") || "").trim(); // widgets can pass ?key=
  if (code.length < 4) return json({ error: "unauthorized" }, 401);
  const space = await sha256("todomate:" + code);

  if (url.pathname === "/api/state") {
    if (request.method === "GET") {
      const row = await env.DB
        .prepare("SELECT data, updated FROM states WHERE id = ?")
        .bind(space)
        .first();
      if (!row) return json({ data: null, updated: 0 });
      let data;
      try { data = JSON.parse(row.data); } catch { data = null; }
      return json({ data, updated: row.updated });
    }

    if (request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const data = JSON.stringify(body?.data ?? {});
      const updated = Number(body?.updated) || Date.now();
      await env.DB
        .prepare(
          "INSERT INTO states (id, data, updated) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated"
        )
        .bind(space, data, updated)
        .run();
      return json({ ok: true, updated });
    }
  }

  // Compact summary of today's items, for a home-screen widget / automation.
  //   GET /api/today?key=<code>&date=YYYY-MM-DD   (date optional, defaults to KST today)
  if (url.pathname === "/api/today" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT data FROM states WHERE id = ?").bind(space).first();
    let st = null;
    if (row) { try { st = JSON.parse(row.data); } catch { st = null; } }
    const date = url.searchParams.get("date") || kstToday();
    const items = computeDay(st, date);
    const remaining = items.filter((i) => !i.done).length;
    const categories = (st && st.categories ? st.categories : []).map((c) => ({ name: c.name, color: c.color }));
    return json({ date, total: items.length, done: items.length - remaining, remaining, items, categories });
  }

  // Toggle one item's done state (from the widget).
  //   POST /api/toggle?key=<code>   body { key: "t:<id>" | "r:<rid>", date: "YYYY-MM-DD" }
  if (url.pathname === "/api/toggle" && request.method === "POST") {
    const row = await env.DB.prepare("SELECT data FROM states WHERE id = ?").bind(space).first();
    if (!row) return json({ error: "no state" }, 404);
    let st;
    try { st = JSON.parse(row.data); } catch { return json({ error: "bad state" }, 500); }
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const key = String(body?.key || "");
    const date = String(body?.date || kstToday());
    let done = null;
    if (key.startsWith("t:")) {
      const id = key.slice(2);
      const t = (st.todos || []).find((x) => x.id === id);
      if (t) { t.done = !t.done; done = t.done; }
    } else if (key.startsWith("r:")) {
      const rid = key.slice(2);
      st.routineDone = st.routineDone || {};
      const k = rid + "|" + date;
      if (st.routineDone[k]) { delete st.routineDone[k]; done = false; }
      else { st.routineDone[k] = true; done = true; }
    }
    if (done === null) return json({ error: "item not found" }, 404);
    const updated = Date.now();
    st.updated = updated;
    await env.DB.prepare("UPDATE states SET data = ?, updated = ? WHERE id = ?")
      .bind(JSON.stringify(st), updated, space).run();
    return json({ ok: true, done, updated });
  }

  return json({ error: "not found" }, 404);
}
