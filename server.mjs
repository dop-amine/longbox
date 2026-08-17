// Road to Secret Wars — static checklist + a tiny sync API.
//
// Deliberately zero npm dependencies: node: builtins only. The whole point of
// this service is to outlive interest in it, and a dependency-free single file
// has no supply chain to rot, no lockfile to refresh and no build step.
//
// Two documents live in DATA_DIR, and the split is the important design idea:
//
//   list.json   — the reading order itself (sections, series, issues). Edited
//                 rarely and deliberately, through the site's edit mode.
//   state.json  — which issues are ticked. Edited constantly, from any device.
//
// They are separate files with separate concurrency models because they have
// separate failure modes. Ticks arrive as per-item ops merged last-write-wins,
// so two devices can never revert each other. List edits are whole-document
// writes guarded by a revision number, so a stale editor is refused outright
// rather than silently overwriting a restructure made elsewhere.
//
// The link between them is the item id, which is FROZEN. Ids were originally
// derived from the item's text, which meant renaming an issue orphaned its
// tick; seed/list.json pins the ids that scheme produced, and nothing
// recomputes them again. An id, once assigned, outlives every edit to the row.
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
const SEED_FILE = fileURLToPath(new URL("./seed/list.json", import.meta.url));
const STATE_FILE = join(DATA_DIR, "state.json");
const LIST_FILE = join(DATA_DIR, "list.json");

const MAX_BODY = 1024 * 1024; // the whole list document is ~60 KB
const MAX_OPS = 2000;
const MAX_ITEMS = 5000;
const ID_RE = /^[a-z0-9-]{1,120}$/;

// Field caps. Generous enough that no real entry hits them, small enough that
// the document can't grow without bound through the editor.
const LIMITS = { n: 16, title: 160, note: 4000, s: 240, i: 160 };
const MAX_SECTIONS = 200;
const MAX_ITEMS_PER_SECTION = 1000;
const MAX_TOTAL_ITEMS = 4000;

/* ---------- state ---------- */

// { rev, updated, items: { <id>: { c: bool, t: epochMs } } }
let state = { rev: 0, updated: 0, items: {} };
// { rev, updated, sections: [ { id, n, title, core, flag, note, items: [...] } ] }
let list = { rev: 0, updated: 0, sections: [] };

// Serialises writes. Concurrent requests would otherwise interleave
// read-modify-write and lose one of them.
let writeChain = Promise.resolve();

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    // A corrupt file must not be silently replaced by an empty one — that
    // reads as "the checklist reset itself" and the data is gone for good.
    console.error(`refusing to start: ${file} is unreadable —`, err.message);
    process.exit(1);
  }
}

function persist(file, doc) {
  writeChain = writeChain
    .then(async () => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(doc), "utf8");
      await rename(tmp, file); // atomic within a filesystem
    })
    .catch((err) => console.error(`persist ${file} failed:`, err.message));
  return writeChain;
}

async function load() {
  const savedState = await readJson(STATE_FILE);
  if (savedState && savedState.items) {
    state = {
      rev: Number(savedState.rev) || 0,
      updated: Number(savedState.updated) || 0,
      items: savedState.items,
    };
  }

  const savedList = await readJson(LIST_FILE);
  if (savedList && Array.isArray(savedList.sections)) {
    list = {
      rev: Number(savedList.rev) || 0,
      updated: Number(savedList.updated) || 0,
      sections: savedList.sections,
    };
    console.log(`list: ${list.sections.length} sections (rev ${list.rev})`);
  } else {
    const seed = await readJson(SEED_FILE);
    if (!seed) {
      console.error(`refusing to start: no ${LIST_FILE} and no seed at ${SEED_FILE}`);
      process.exit(1);
    }
    list = { rev: 0, updated: Date.now(), sections: seed.sections };
    await persist(LIST_FILE, list);
    console.log(`list: seeded ${list.sections.length} sections from ${SEED_FILE}`);
  }

  console.log(`state: ${Object.keys(state.items).length} items (rev ${state.rev})`);
}

/* ---------- ticks ---------- */

// Per-item last-write-wins. This is what makes two devices safe: a full-state
// save from a phone that was offline would revert ticks made on the laptop,
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
    persist(STATE_FILE, state);
  }
  return changed;
}

/* ---------- list ---------- */

class Invalid extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function str(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new Invalid(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Invalid(`${field} is required`);
  if (trimmed.length > max) throw new Invalid(`${field} exceeds ${max} characters`);
  // Control characters would render as invisible junk and can't be typed
  // deliberately; strip rather than reject so a paste from a PDF still works.
  let clean = "";
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) clean += ch;
  }
  return clean;
}

function validateList(input) {
  if (!input || typeof input !== "object") throw new Invalid("expected an object");
  if (!Array.isArray(input.sections)) throw new Invalid("sections must be an array");
  if (input.sections.length > MAX_SECTIONS) throw new Invalid("too many sections");

  const seen = new Set();
  let total = 0;

  const sections = input.sections.map((sec, si) => {
    if (!sec || typeof sec !== "object") throw new Invalid(`section ${si} is not an object`);
    if (typeof sec.id !== "string" || !ID_RE.test(sec.id)) throw new Invalid(`section ${si} has an invalid id`);
    // A duplicate id makes two rows tick as one, and is unrecoverable once
    // ticks accumulate against it.
    if (seen.has(sec.id)) throw new Invalid(`duplicate id ${sec.id}`);
    seen.add(sec.id);

    if (!Array.isArray(sec.items)) throw new Invalid(`section ${si} has no items array`);
    if (sec.items.length > MAX_ITEMS_PER_SECTION) throw new Invalid(`section ${si} has too many items`);
    total += sec.items.length;
    if (total > MAX_TOTAL_ITEMS) throw new Invalid("too many items in total");

    return {
      id: sec.id,
      n: str(sec.n, `section ${si} number`, LIMITS.n),
      title: str(sec.title, `section ${si} title`, LIMITS.title, { required: true }),
      core: !!sec.core,
      flag: !!sec.flag,
      note: str(sec.note, `section ${si} note`, LIMITS.note),
      // Which trade/omnibus covers this section, and the year — kept separate
      // from `note` so the editorial line stays prose and this stays a lookup
      // you can scan while standing in front of a library.
      collected: str(sec.collected, `section ${si} collected`, LIMITS.note),
      items: sec.items.map((it, ii) => {
        if (!it || typeof it !== "object") throw new Invalid(`item ${si}.${ii} is not an object`);
        if (typeof it.id !== "string" || !ID_RE.test(it.id)) throw new Invalid(`item ${si}.${ii} has an invalid id`);
        if (seen.has(it.id)) throw new Invalid(`duplicate id ${it.id}`);
        seen.add(it.id);
        return {
          id: it.id,
          s: str(it.s, `item ${si}.${ii} series`, LIMITS.s, { required: true }),
          i: str(it.i, `item ${si}.${ii} issue`, LIMITS.i),
          note: str(it.note, `item ${si}.${ii} note`, LIMITS.note),
          alt: !!it.alt,
        };
      }),
    };
  });

  return sections;
}

// A tick for a row that no longer exists is invisible but would come back to
// life if the same id were ever reused, so drop it with the row.
function purgeOrphanTicks(sections) {
  const live = new Set(sections.flatMap((sec) => sec.items.map((it) => it.id)));
  let dropped = 0;
  for (const id of Object.keys(state.items)) {
    if (!live.has(id)) {
      delete state.items[id];
      dropped++;
    }
  }
  if (dropped) {
    state.rev++;
    state.updated = Date.now();
    persist(STATE_FILE, state);
  }
  return dropped;
}

/* ---------- http ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
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

async function parseBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Invalid("invalid json");
  }
}

async function serveStatic(res, urlPath) {
  const rel =
    urlPath === "/"
      ? "index.html"
      : normalize(urlPath).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
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
  // The page is the app: never cache it, or a stale shell keeps talking to a
  // newer API.
  send(res, 200, buf, {
    "content-type": MIME[extname(full)] || "application/octet-stream",
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
      return sendJson(res, 200, {
        ok: true,
        rev: state.rev,
        items: Object.keys(state.items).length,
        listRev: list.rev,
        sections: list.sections.length,
      });
    }

    if (path === "/api/state") {
      if (req.method === "GET") return sendJson(res, 200, state);
      if (req.method === "PATCH" || req.method === "POST") {
        const payload = await parseBody(req);
        const ops = Array.isArray(payload.ops) ? payload.ops : null;
        if (!ops) throw new Invalid("expected { ops: [...] }");
        if (ops.length > MAX_OPS) return sendJson(res, 413, { error: "too many ops" });

        const changed = applyOps(ops);
        // Flush before answering: the client treats a 200 as "the server owns
        // these ops now" and drops them from its queue.
        await writeChain;
        console.log(`patch: ${ops.length} ops, ${changed} applied, rev ${state.rev}`);
        return sendJson(res, 200, state);
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (path === "/api/list") {
      if (req.method === "GET") return sendJson(res, 200, list);
      if (req.method === "PUT") {
        const payload = await parseBody(req);

        // Optimistic concurrency. Without this, a phone showing yesterday's
        // list would quietly delete every section added since.
        if (Number(payload.rev) !== list.rev) {
          return sendJson(res, 409, {
            error: "the list changed elsewhere",
            rev: list.rev,
            updated: list.updated,
            sections: list.sections,
          });
        }

        const sections = validateList(payload);
        list = { rev: list.rev + 1, updated: Date.now(), sections };
        persist(LIST_FILE, list);
        const dropped = purgeOrphanTicks(sections);
        await writeChain;
        console.log(
          `list: rev ${list.rev}, ${sections.length} sections, ` +
            `${sections.reduce((n, s) => n + s.items.length, 0)} items` +
            (dropped ? `, ${dropped} orphan ticks dropped` : "")
        );
        return sendJson(res, 200, list);
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
await load();

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
