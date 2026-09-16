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
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
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

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (!env.DB) return json({ error: "D1 binding 'DB' is not configured" }, 500);

  const auth = request.headers.get("Authorization") || "";
  const code = auth.replace(/^Bearer\s+/i, "").trim();
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

  return json({ error: "not found" }, 404);
}
