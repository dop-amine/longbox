// A self-hosted checklist for comic reading orders.
//
// Deliberately zero npm dependencies: node: builtins only. The whole point of
// this service is to outlive interest in it, and a dependency-free single file
// has no supply chain to rot, no lockfile to refresh and no build step.
//
// DATA LAYOUT (under DATA_DIR)
//
//   orders/<id>.json  — one reading order: its masthead text and its sections.
//                       Edited rarely and deliberately, through the site.
//   state.json        — which issues are ticked, namespaced by order id.
//                       Edited constantly, from any device.
//
// The split matters because the two fail differently. Ticks arrive as per-item
// ops merged last-write-wins, so two devices can never revert each other. Order
// edits are whole-document writes guarded by a revision number, so a stale
// editor is refused outright rather than silently overwriting a restructure
// made elsewhere.
//
// Item ids are FROZEN. They were once derived from the item's text, which meant
// renaming an issue orphaned its tick; nothing recomputes them now. An id, once
// assigned, outlives every edit to the row. Ticks are namespaced per order, so
// two orders may reuse an id without colliding.
//
// seed/*.json are bundled example orders. They are installed when the data
// directory is empty and are otherwise offered as importable starting points —
// dropping a new .json in there adds one, no code change.
//
// There is no auth here on purpose. The gate is the network: the container
// binds loopback only, and a reverse proxy in front restricts by source IP.
// Do not expose this publicly without adding a gate first — anyone who can
// reach it can rewrite every list.

import { createServer } from "node:http";
import { readFile, writeFile, rename, mkdir, readdir, unlink } from "node:fs/promises";
import { join, extname, normalize, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const SEED_DIR = fileURLToPath(new URL("./seed/", import.meta.url));
const ORDERS_DIR = join(DATA_DIR, "orders");
const STATE_FILE = join(DATA_DIR, "state.json");
const LEGACY_LIST = join(DATA_DIR, "list.json");

const MAX_BODY = 4 * 1024 * 1024;
const MAX_OPS = 2000;
const MAX_TICKS_PER_ORDER = 5000;
const ID_RE = /^[a-z0-9-]{1,120}$/;

const LIMITS = { n: 16, title: 160, note: 4000, s: 240, i: 160, word: 40, url: 2000 };
const HISTORY_DEPTH = 20;
const MAX_ORDERS = 100;
const MAX_SECTIONS = 200;
const MAX_ITEMS_PER_SECTION = 1000;
const MAX_TOTAL_ITEMS = 4000;

/* ---------- in-memory state ---------- */

// id -> { id, rev, updated, title, titleAccent, eyebrow, deck, tagline,
//         progressWord, sections: [...] }
const orders = new Map();
// { rev, updated, orders: { <orderId>: { <itemId>: { c, t } } } }
let state = { rev: 0, updated: 0, orders: {} };

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

const orderFile = (id) => join(ORDERS_DIR, `${id}.json`);
const historyFile = (id) => join(ORDERS_DIR, `${id}.history.json`);
const persistOrder = (order) => persist(orderFile(order.id), order);
const persistState = () => persist(STATE_FILE, state);

// Unlike readJson, a damaged history file is not worth refusing to start over:
// it is a convenience, and the current document is elsewhere.
async function readHistory(id) {
  try {
    return JSON.parse(await readFile(historyFile(id), "utf8"));
  } catch {
    return { id, revisions: [] };
  }
}

// Keeps the last HISTORY_DEPTH versions of an order so an accidental delete of
// a forty-entry section is recoverable. Called with the doc being replaced.
// The ticks are snapshotted with the document because deleting a section
// purges the ticks under it. Without them, undoing a delete would bring back
// forty rows with every one of them unread.
async function recordHistory(previous, ticks) {
  const history = await readHistory(previous.id);
  history.revisions.unshift({
    rev: previous.rev,
    updated: previous.updated,
    doc: previous,
    ticks: { ...ticks },
  });
  history.revisions = history.revisions.slice(0, HISTORY_DEPTH);
  return persist(historyFile(previous.id), history);
}

/* ---------- validation ---------- */

class Invalid extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
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

// The masthead text. Every field is optional except the title, so a brand new
// order is usable before anyone writes any copy for it.
// A link on a row points at wherever the issue actually lives — a comic
// server, a store page, a wiki. Only http(s): a javascript: or data: URL in a
// field the page renders as an anchor is a script-injection waiting to happen.
function link(value, field) {
  const raw = str(value, field, LIMITS.url);
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Invalid(`${field} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Invalid(`${field} must be an http or https link`);
  }
  return parsed.href;
}

function validateMeta(input) {
  return {
    title: str(input.title, "title", LIMITS.title, { required: true }),
    // The part of the title printed in the accent colour, on its own line.
    titleAccent: str(input.titleAccent, "title accent", LIMITS.title),
    eyebrow: str(input.eyebrow, "eyebrow", LIMITS.title),
    deck: str(input.deck, "deck", LIMITS.note),
    tagline: str(input.tagline, "tagline", LIMITS.title),
    // The readout under the meter is "0% <progressWord> · <mainLabel>", and the
    // dock counts "<mainLabel> 3/10 · <optionalLabel> 1/4". All three are the
    // order's vocabulary, not the app's: a Secret Wars list converges on its
    // main line, a completionist run just completes.
    progressWord: str(input.progressWord, "progress word", LIMITS.word) || "complete",
    mainLabel: str(input.mainLabel, "main label", LIMITS.word) || "main line",
    optionalLabel: str(input.optionalLabel, "optional label", LIMITS.word) || "optional",
  };
}

function validateSections(input) {
  if (!Array.isArray(input)) throw new Invalid("sections must be an array");
  if (input.length > MAX_SECTIONS) throw new Invalid("too many sections");

  const seen = new Set();
  let total = 0;

  return input.map((sec, si) => {
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
          // Where to actually read it.
          url: link(it.url, `item ${si}.${ii} link`),
          alt: !!it.alt,
        };
      }),
    };
  });
}

/* ---------- tolerant import ---------- */

// Anything written by hand or by a model arrives close-but-not-exact: ids
// missing, "series" instead of "s", an item that is just a string. The strict
// validator above guards what the app itself writes; this one meets an author
// halfway, then hands the result to the strict validator so nothing invalid
// can slip past. Field names below are the ones people actually reach for.
const SECTION_KEYS = {
  title: ["title", "name", "heading", "section"],
  n: ["n", "number", "num", "index"],
  note: ["note", "notes", "description", "summary"],
  collected: ["collected", "collectedEditions", "editions", "volumes"],
  items: ["items", "entries", "issues", "comics", "books"],
  core: ["core", "main", "required", "essential"],
  flag: ["flag", "flagged", "highlight"],
};
const ITEM_KEYS = {
  s: ["s", "series", "title", "name", "comic", "book"],
  i: ["i", "issue", "issues", "number", "num"],
  note: ["note", "notes", "comment", "description"],
  url: ["url", "link", "href"],
  alt: ["alt", "alternate", "tint"],
};
const META_KEYS = {
  title: ["title", "name"],
  titleAccent: ["titleAccent", "accent"],
  eyebrow: ["eyebrow", "kicker", "supertitle"],
  deck: ["deck", "intro", "description", "subtitle"],
  tagline: ["tagline", "footer"],
  progressWord: ["progressWord", "progressVerb"],
  mainLabel: ["mainLabel", "mainName"],
  optionalLabel: ["optionalLabel", "optionalName"],
};

function pick(obj, names) {
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return undefined;
}

function mapKeys(obj, spec) {
  const out = {};
  for (const [canonical, names] of Object.entries(spec)) {
    const value = pick(obj, names);
    if (value !== undefined) out[canonical] = value;
  }
  return out;
}

// Returns { doc, generatedIds }. Never throws for a missing id — that is the
// single most common thing an author leaves out, and inventing one is safe
// because nothing has been ticked against this list yet.
function normaliseImport(input) {
  if (!input || typeof input !== "object") throw new Invalid("expected a JSON object");

  const meta = mapKeys(input, META_KEYS);
  const rawSections = pick(input, SECTION_KEYS.items) ?? input.sections ?? [];
  if (!Array.isArray(rawSections)) throw new Invalid("sections must be an array");

  const seen = new Set();
  let generatedIds = 0;
  const takeId = (raw) => {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!ID_RE.test(id) || seen.has(id)) {
      generatedIds++;
      const fresh = "x-" + randomUUID();
      seen.add(fresh);
      return fresh;
    }
    seen.add(id);
    return id;
  };

  const sections = rawSections.map((rawSection) => {
    const source = typeof rawSection === "string" ? { title: rawSection } : rawSection || {};
    const sec = mapKeys(source, SECTION_KEYS);
    const rawItems = Array.isArray(sec.items) ? sec.items : [];

    return {
      id: takeId(source.id),
      n: sec.n === undefined ? "" : String(sec.n),
      title: sec.title === undefined ? "Untitled section" : String(sec.title),
      // Sections count toward the main line unless they say otherwise: a list
      // is mostly main line, and an author who omits the flag means the common case.
      core: sec.core === undefined ? true : !!sec.core,
      flag: !!sec.flag,
      note: sec.note === undefined ? "" : String(sec.note),
      collected: sec.collected === undefined ? "" : String(sec.collected),
      items: rawItems.map((rawItem) => {
        const itemSource = typeof rawItem === "string" ? { s: rawItem } : rawItem || {};
        const it = mapKeys(itemSource, ITEM_KEYS);
        return {
          id: takeId(itemSource.id),
          s: it.s === undefined ? "" : String(it.s),
          i: it.i === undefined ? "" : String(it.i),
          note: it.note === undefined ? "" : String(it.note),
          url: it.url === undefined ? "" : String(it.url),
          alt: !!it.alt,
        };
      }),
    };
  });

  return { doc: { ...meta, sections }, generatedIds };
}

function slugify(text, fallback = "reading-order") {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function uniqueOrderId(base) {
  let id = slugify(base);
  if (!orders.has(id)) return id;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${id}-${n}`.slice(0, 64);
    if (!orders.has(candidate)) return candidate;
  }
  throw new Invalid("could not allocate an id for this order");
}

const countItems = (order) => order.sections.reduce((n, s) => n + s.items.length, 0);

const summarise = (order) => ({
  id: order.id,
  title: order.title,
  titleAccent: order.titleAccent,
  rev: order.rev,
  updated: order.updated,
  sections: order.sections.length,
  items: countItems(order),
});

/* ---------- loading, seeding, migration ---------- */

async function listSeeds() {
  let files = [];
  try {
    files = (await readdir(SEED_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const seeds = [];
  for (const file of files.sort()) {
    const doc = await readJson(join(SEED_DIR, file));
    if (!doc) continue;
    const id = doc.id || basename(file, ".json");
    seeds.push({ ...doc, id });
  }
  return seeds;
}

function adoptOrder(id, doc, rev = 0) {
  const order = {
    id,
    rev,
    updated: Number(doc.updated) || Date.now(),
    ...validateMeta(doc),
    sections: validateSections(doc.sections || []),
  };
  orders.set(id, order);
  return order;
}

// The single-list layout this started as: DATA_DIR/list.json plus a flat
// state.json. Convert in place, keep the originals as .migrated rather than
// deleting them, and namespace the existing ticks under the new order.
async function migrateLegacy() {
  const legacy = await readJson(LEGACY_LIST);
  if (!legacy || !Array.isArray(legacy.sections)) return false;

  const seeds = await listSeeds();
  // Prefer the seed's identity, so the migrated order matches the shipped
  // example rather than inventing a new title.
  const example = seeds[0] || {};
  const id = slugify(example.title || "road-to-secret-wars");

  const order = adoptOrder(
    id,
    {
      title: example.title || "Road to Secret Wars",
      titleAccent: example.titleAccent || "",
      eyebrow: example.eyebrow || "",
      deck: example.deck || "",
      tagline: example.tagline || "",
      progressWord: example.progressWord || "complete",
      sections: legacy.sections,
      updated: legacy.updated,
    },
    Number(legacy.rev) || 0
  );
  await persistOrder(order);

  const legacyState = await readJson(STATE_FILE);
  if (legacyState && legacyState.items && !legacyState.orders) {
    state = {
      rev: Number(legacyState.rev) || 0,
      updated: Number(legacyState.updated) || Date.now(),
      orders: { [id]: legacyState.items },
    };
    await persistState();
    console.log(`migrated ${Object.keys(legacyState.items).length} ticks into "${id}"`);
  }

  await rename(LEGACY_LIST, `${LEGACY_LIST}.migrated`);
  console.log(`migrated legacy list.json -> orders/${id}.json (kept a .migrated backup)`);
  return true;
}

async function load() {
  await mkdir(ORDERS_DIR, { recursive: true });

  const saved = await readJson(STATE_FILE);
  if (saved && saved.orders) {
    state = {
      rev: Number(saved.rev) || 0,
      updated: Number(saved.updated) || 0,
      orders: saved.orders,
    };
  }

  let files = [];
  try {
    // .history.json sits alongside each order; adopting one as an order would
    // put a second copy of every list in the library.
    files = (await readdir(ORDERS_DIR)).filter(
      (f) => f.endsWith(".json") && !f.endsWith(".history.json")
    );
  } catch {}

  for (const file of files.sort()) {
    const doc = await readJson(join(ORDERS_DIR, file));
    if (!doc) continue;
    const id = doc.id || basename(file, ".json");
    try {
      adoptOrder(id, doc, Number(doc.rev) || 0);
    } catch (err) {
      console.error(`refusing to start: orders/${file} is not a valid order — ${err.message}`);
      process.exit(1);
    }
  }

  if (!orders.size) {
    const migrated = await migrateLegacy();
    if (!migrated) {
      const seeds = await listSeeds();
      if (!seeds.length) {
        console.error(`refusing to start: no orders in ${ORDERS_DIR} and no seeds in ${SEED_DIR}`);
        process.exit(1);
      }
      for (const seed of seeds) {
        const order = adoptOrder(slugify(seed.title || seed.id), seed);
        await persistOrder(order);
        console.log(`installed example "${order.title}" (${order.sections.length} sections)`);
      }
    }
  }

  console.log(
    `${orders.size} reading order(s): ` +
      [...orders.values()].map((o) => `${o.id} (${countItems(o)} items)`).join(", ")
  );
}

/* ---------- ticks ---------- */

function ticksFor(orderId) {
  if (!state.orders[orderId]) state.orders[orderId] = {};
  return state.orders[orderId];
}

// Per-item last-write-wins. This is what makes two devices safe: a full-state
// save from a phone that was offline would revert ticks made on the laptop,
// whereas merging per item by timestamp only ever loses the older edit of the
// same item.
function applyOps(orderId, ops) {
  const items = ticksFor(orderId);
  const now = Date.now();
  let changed = 0;

  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    if (typeof op.id !== "string" || !ID_RE.test(op.id)) continue;
    if (typeof op.c !== "boolean") continue;

    // Clamp forward-skewed client clocks; a device an hour fast would
    // otherwise win every future conflict against every other device.
    const t = Math.min(Number(op.t) || now, now);
    const cur = items[op.id];
    if (cur && cur.t > t) continue; // a newer edit already won
    if (cur && cur.c === op.c) continue; // no-op replay
    if (!cur && op.c === false) continue; // unticking something never ticked
    if (!cur && Object.keys(items).length >= MAX_TICKS_PER_ORDER) continue;

    items[op.id] = { c: op.c, t };
    changed++;
  }

  if (changed) {
    state.rev++;
    state.updated = now;
    persistState();
  }
  return changed;
}

// A tick for a row that no longer exists is invisible but would come back to
// life if the same id were ever reused, so drop it with the row.
function purgeOrphanTicks(orderId, sections) {
  const items = ticksFor(orderId);
  const live = new Set(sections.flatMap((sec) => sec.items.map((it) => it.id)));
  let dropped = 0;
  for (const id of Object.keys(items)) {
    if (!live.has(id)) {
      delete items[id];
      dropped++;
    }
  }
  if (dropped) {
    state.rev++;
    state.updated = Date.now();
    persistState();
  }
  return dropped;
}

/* ---------- http plumbing ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  // text/plain rather than text/markdown so the browser shows the authoring
  // guide inline instead of downloading it.
  ".md": "text/plain; charset=utf-8",
};

const staticCache = new Map();

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { "content-type": MIME[".json"], ...headers });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Invalid("body too large", 413));
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

/* ---------- routes ---------- */

function requireOrder(id) {
  const order = orders.get(id);
  if (!order) throw new Invalid(`no reading order "${id}"`, 404);
  return order;
}

async function createOrder(payload) {
  if (orders.size >= MAX_ORDERS) throw new Invalid("too many reading orders");

  let doc;
  if (payload.seed) {
    const seeds = await listSeeds();
    const seed = seeds.find((s) => s.id === payload.seed || slugify(s.title || s.id) === payload.seed);
    if (!seed) throw new Invalid(`no example named "${payload.seed}"`, 404);
    doc = seed;
  } else if (payload.copy) {
    // Duplicate an order you already have — the safe way to try a restructure
    // without touching the list you are actually reading. Ticks stay behind.
    const source = requireOrder(payload.copy);
    const { id: _id, rev: _rev, updated: _updated, ...rest } = source;
    doc = { ...rest, title: payload.title || `${source.title} (copy)` };
  } else if (payload.order) {
    doc = normaliseImport(payload.order).doc; // hand-written or AI-written
  } else {
    doc = {
      title: payload.title || "New reading order",
      deck: "",
      sections: [],
    };
  }

  const id = uniqueOrderId(doc.title || payload.title || "reading-order");
  const order = adoptOrder(id, { ...doc, updated: Date.now() }, 0);
  await persistOrder(order);
  console.log(`created "${order.title}" as ${id} (${countItems(order)} items)`);
  return order;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/healthz") {
      return sendJson(res, 200, {
        ok: true,
        orders: orders.size,
        items: [...orders.values()].reduce((n, o) => n + countItems(o), 0),
        stateRev: state.rev,
      });
    }

    if (path === "/api/seeds" && req.method === "GET") {
      const seeds = await listSeeds();
      return sendJson(
        res,
        200,
        seeds.map((s) => ({
          id: s.id,
          title: s.title || s.id,
          deck: s.deck || "",
          sections: (s.sections || []).length,
          items: (s.sections || []).reduce((n, sec) => n + (sec.items || []).length, 0),
        }))
      );
    }

    // Dry run: check a document without saving it. Point an author (or their
    // model) at this before importing, so a malformed list produces a specific
    // complaint instead of a rejected upload.
    if (path === "/api/validate" && req.method === "POST") {
      const payload = await parseBody(req);
      try {
        const { doc, generatedIds } = normaliseImport(payload.order || payload);
        const meta = validateMeta(doc);
        const sections = validateSections(doc.sections);
        return sendJson(res, 200, {
          ok: true,
          title: meta.title,
          sections: sections.length,
          items: sections.reduce((n, s) => n + s.items.length, 0),
          generatedIds,
          emptySections: sections.filter((s) => !s.items.length).map((s) => s.title),
        });
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        return sendJson(res, 200, { ok: false, error: err.message });
      }
    }

    // Everything, in one file: every order and every tick. The data directory
    // is otherwise the only copy, and a per-order export deliberately drops
    // the ticks — which is exactly what you want back after a disaster.
    if (path === "/api/backup" && req.method === "GET") {
      const stamp = new Date().toISOString().slice(0, 10);
      return sendJson(
        res,
        200,
        {
          format: "longbox-backup",
          version: 1,
          exported: Date.now(),
          orders: [...orders.values()],
          ticks: state.orders,
        },
        { "content-disposition": `attachment; filename="longbox-${stamp}.json"` }
      );
    }

    if (path === "/api/restore" && req.method === "POST") {
      const payload = await parseBody(req);
      if (!Array.isArray(payload.orders)) throw new Invalid("expected a backup with an orders array");

      // Restores by id: an order in the backup replaces the one on disk, and
      // anything not mentioned is left alone. Nothing is deleted here — an
      // accidental restore should never be the thing that loses a list.
      let restored = 0;
      for (const doc of payload.orders) {
        const id = typeof doc.id === "string" && ID_RE.test(doc.id) ? doc.id : uniqueOrderId(doc.title || "restored");
        const existing = orders.get(id);
        if (existing) await recordHistory(existing, ticksFor(id));
        const order = {
          id,
          rev: (existing ? existing.rev : 0) + 1,
          updated: Date.now(),
          ...validateMeta(doc),
          sections: validateSections(doc.sections || []),
        };
        orders.set(id, order);
        persistOrder(order);
        restored++;
      }

      let ticks = 0;
      for (const [orderId, items] of Object.entries(payload.ticks || {})) {
        if (!orders.has(orderId) || !items || typeof items !== "object") continue;
        const live = ticksFor(orderId);
        for (const [itemId, value] of Object.entries(items)) {
          if (!ID_RE.test(itemId) || !value || typeof value.c !== "boolean") continue;
          const t = Math.min(Number(value.t) || Date.now(), Date.now());
          // Same last-write-wins rule as a live sync: a restore must not
          // silently undo something ticked after the backup was taken.
          if (!live[itemId] || live[itemId].t <= t) {
            live[itemId] = { c: value.c, t };
            ticks++;
          }
        }
      }
      state.rev++;
      state.updated = Date.now();
      persistState();
      await writeChain;
      console.log(`restore: ${restored} orders, ${ticks} ticks`);
      return sendJson(res, 200, { restored, ticks, orders: [...orders.values()].map(summarise) });
    }

    if (path === "/api/orders") {
      if (req.method === "GET") {
        // Sorted by title, always. In-memory the orders sit in creation order
        // and on disk they come back in filename order, so an unsorted index
        // quietly reshuffles the dropdown the first time the service restarts.
        return sendJson(
          res,
          200,
          [...orders.values()]
            .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
            .map(summarise)
        );
      }
      if (req.method === "POST") {
        const order = await createOrder(await parseBody(req));
        return sendJson(res, 201, order);
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }

    const orderMatch = path.match(/^\/api\/orders\/([a-z0-9-]{1,64})(?:\/(export|history|revert))?$/);
    if (orderMatch) {
      const [, id, actionRaw] = orderMatch;
      const action = actionRaw || "";
      const exporting = action === "export";
      const order = requireOrder(id);

      if (action === "history") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const history = await readHistory(id);
        return sendJson(
          res,
          200,
          history.revisions.map((r) => ({
            rev: r.rev,
            updated: r.updated,
            sections: (r.doc.sections || []).length,
            items: (r.doc.sections || []).reduce((n, s) => n + (s.items || []).length, 0),
          }))
        );
      }

      if (action === "revert") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const payload = await parseBody(req);
        const history = await readHistory(id);
        const target =
          payload.rev === undefined
            ? history.revisions[0]
            : history.revisions.find((r) => r.rev === Number(payload.rev));
        if (!target) throw new Invalid("no earlier version to go back to", 404);

        // Forward-only: going back writes a NEW revision rather than rewinding
        // the counter, so the undo itself can be undone and no history is lost.
        await recordHistory(order, ticksFor(id));
        const restored = {
          id,
          rev: order.rev + 1,
          updated: Date.now(),
          ...validateMeta(target.doc),
          sections: validateSections(target.doc.sections),
        };
        orders.set(id, restored);
        persistOrder(restored);

        // Put back the ticks that were purged along with whatever this undoes,
        // but never overwrite a tick made since.
        const live = ticksFor(id);
        const ids = new Set(restored.sections.flatMap((s) => s.items.map((it) => it.id)));
        let revived = 0;
        for (const [itemId, value] of Object.entries(target.ticks || {})) {
          if (ids.has(itemId) && !live[itemId]) {
            live[itemId] = value;
            revived++;
          }
        }
        if (revived) {
          state.rev++;
          state.updated = Date.now();
          persistState();
        }
        await writeChain;
        console.log(`${id}: reverted to rev ${target.rev} as rev ${restored.rev}, ${revived} ticks revived`);
        return sendJson(res, 200, restored);
      }

      if (req.method === "GET") {
        if (exporting) {
          // Everything needed to recreate this list elsewhere — deliberately
          // without ticks, which belong to whoever is reading, not to the list.
          const { rev, updated, ...portable } = order;
          return sendJson(res, 200, portable, {
            "content-disposition": `attachment; filename="${id}.json"`,
          });
        }
        return sendJson(res, 200, order);
      }

      if (exporting) return sendJson(res, 405, { error: "method not allowed" });

      if (req.method === "PUT") {
        const payload = await parseBody(req);
        // Optimistic concurrency. Without this, a phone showing yesterday's
        // list would quietly delete every section added since.
        if (Number(payload.rev) !== order.rev) {
          return sendJson(res, 409, { error: "the list changed elsewhere", ...order });
        }
        const updated = {
          id,
          rev: order.rev + 1,
          updated: Date.now(),
          ...validateMeta(payload),
          sections: validateSections(payload.sections),
        };
        // Snapshot before anything is purged, so undo can put the ticks back.
        await recordHistory(order, ticksFor(id));
        orders.set(id, updated);
        persistOrder(updated);
        const dropped = purgeOrphanTicks(id, updated.sections);
        await writeChain;
        console.log(
          `${id}: rev ${updated.rev}, ${updated.sections.length} sections, ` +
            `${countItems(updated)} items` + (dropped ? `, ${dropped} orphan ticks dropped` : "")
        );
        return sendJson(res, 200, updated);
      }

      if (req.method === "DELETE") {
        if (orders.size === 1) throw new Invalid("this is the only reading order — create another first");
        orders.delete(id);
        delete state.orders[id];
        state.rev++;
        state.updated = Date.now();
        persistState();
        await writeChain;
        await unlink(orderFile(id)).catch(() => {});
        await unlink(historyFile(id)).catch(() => {});
        console.log(`deleted ${id}`);
        return sendJson(res, 200, { deleted: id });
      }

      return sendJson(res, 405, { error: "method not allowed" });
    }

    const stateMatch = path.match(/^\/api\/state\/([a-z0-9-]{1,64})$/);
    if (stateMatch) {
      const id = stateMatch[1];
      requireOrder(id);

      if (req.method === "GET") {
        return sendJson(res, 200, { rev: state.rev, items: ticksFor(id) });
      }
      if (req.method === "PATCH" || req.method === "POST") {
        const payload = await parseBody(req);
        const ops = Array.isArray(payload.ops) ? payload.ops : null;
        if (!ops) throw new Invalid("expected { ops: [...] }");
        if (ops.length > MAX_OPS) throw new Invalid("too many ops", 413);

        const changed = applyOps(id, ops);
        // Flush before answering: the client treats a 200 as "the server owns
        // these ops now" and drops them from its queue.
        await writeChain;
        console.log(`${id}: ${ops.length} ops, ${changed} applied, state rev ${state.rev}`);
        return sendJson(res, 200, { rev: state.rev, items: ticksFor(id) });
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
  console.log(`listening on :${PORT} (data: ${DATA_DIR})`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(async () => {
      await writeChain; // don't lose a tick made a millisecond before the roll
      process.exit(0);
    });
  });
}
