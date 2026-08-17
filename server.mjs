// Road to Secret Wars — static checklist + a tiny sync API.
//
// Deliberately zero npm dependencies: node: builtins only. The whole point of
// this service is to outlive interest in it, and a dependency-free single file
// has no supply chain to rot, no lockfile to refresh and no build step.
//
// State is one JSON document on disk (DATA_DIR/state.json), bind-mounted from
// the host so it survives image rolls and rebuilds.
//
// There is no auth here on purpose. The gate is the network: the container
// binds loopback only, and a reverse proxy in front restricts by source IP.
// Do not expose this publicly without adding a gate first — anyone who can
// reach it can rewrite the checklist.

import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const STATE_FILE = join(DATA_DIR, "state.json");

const MAX_BODY = 256 * 1024; // a full reset of ~250 items is ~20 KB
const MAX_OPS = 2000;
const MAX_ITEMS = 5000; // ceiling on distinct ids ever stored
const ID_RE = /^[a-z0-9-]{1,120}$/;

/* ---------- state ---------- */

// { rev: n, updated: epochMs, items: { <id>: { c: bool, t: epochMs } } }
let state = { rev: 0, updated: 0, items: {} };

// Serialises writes. Concurrent PATCHes from two devices would otherwise
// interleave read-modify-write and lose one of them.
let writeChain = Promise.resolve();

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.items) {
      state = {
        rev: Number(parsed.rev) || 0,
        updated: Number(parsed.updated) || 0,
        items: parsed.items,
      };
    }
    console.log(`loaded ${Object.keys(state.items).length} items (rev ${state.rev})`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      // A corrupt file must not be silently replaced by an empty one — that
      // reads as "checklist reset itself" and the ticks are gone for good.
      console.error(`refusing to start: ${STATE_FILE} is unreadable —`, err.message);
      process.exit(1);
    }
    console.log("no state file yet — starting empty");
  }
}

// Write to a temp file and rename: rename is atomic within a filesystem, so a
// power cut can leave the old state or the new one, never a half-written file.
function persist() {
  writeChain = writeChain.then(async () => {
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, STATE_FILE);
  }).catch((err) => {
    console.error("persist failed:", err.message);
  });
  return writeChain;
}

// Per-item last-write-wins. This is what makes two devices safe: a full-state
// PUT from a phone that was offline would revert ticks made on the laptop,
// whereas merging per item by timestamp only ever loses the older edit of the
// same item.
function applyOps(ops) {
  const now = Date.now();
  let changed = 0;
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    if (typeof op.id !== "string" || !ID_RE.test(op.id)) continue;
    if (typeof op.c !== "boolean") continue;

    // Clamp forward-skewed client clocks; a device an hour fast would
    // otherwise win every future conflict against every other device.
    const t = Math.min(Number(op.t) || now, now);
    const cur = state.items[op.id];
    if (cur && cur.t > t) continue; // a newer edit already won
    if (cur && cur.c === op.c) continue; // no-op replay
    if (!cur && op.c === false) continue; // unticking something never ticked
    if (!cur && Object.keys(state.items).length >= MAX_ITEMS) continue;

    state.items[op.id] = { c: op.c, t };
    changed++;
  }
  if (changed) {
    state.rev++;
    state.updated = now;
    persist();
  }
  return changed;
}

/* ---------- http ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const staticCache = new Map(); // path -> Buffer. Files never change in an image.

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "content-type": MIME[".json"] });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : normalize(urlPath).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  const full = join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden");

  let buf = staticCache.get(full);
  if (!buf) {
    try {
      buf = await readFile(full);
      staticCache.set(full, buf);
    } catch {
      return send(res, 404, "not found", { "content-type": MIME[".txt"] });
    }
  }
  const type = MIME[extname(full)] || "application/octet-stream";
  // The page is the app: never cache it, or a stale shell keeps talking to a
  // newer API. Assets are content-free enough that no-store costs nothing here.
  send(res, 200, buf, {
    "content-type": type,
    "content-security-policy":
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "script-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "base-uri 'none'; frame-ancestors 'none'",
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/healthz") {
      return sendJson(res, 200, { ok: true, rev: state.rev, items: Object.keys(state.items).length });
    }

    if (path === "/api/state") {
      if (req.method === "GET") {
        return sendJson(res, 200, state);
      }
      if (req.method === "PATCH" || req.method === "POST") {
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          return sendJson(res, 400, { error: "invalid json" });
        }
        const ops = Array.isArray(payload.ops) ? payload.ops : null;
        if (!ops) return sendJson(res, 400, { error: "expected { ops: [...] }" });
        if (ops.length > MAX_OPS) return sendJson(res, 413, { error: "too many ops" });

        const changed = applyOps(ops);
        // Flush before answering. The client treats a 200 as "the server owns
        // these ops now" and drops them from its queue.
        await writeChain;
        console.log(`patch: ${ops.length} ops, ${changed} applied, rev ${state.rev}`);
        return sendJson(res, 200, state);
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (req.method !== "GET") return send(res, 405, "method not allowed");
    return await serveStatic(res, path);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error("request failed:", err);
    return sendJson(res, status, { error: err.message || "server error" });
  }
});

await mkdir(DATA_DIR, { recursive: true });
await loadState();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`secret-wars listening on :${PORT} (data: ${DATA_DIR})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(async () => {
      await writeChain; // don't lose a tick made a millisecond before the roll
      process.exit(0);
    });
  });
}
