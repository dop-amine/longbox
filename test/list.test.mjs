// Exercises the editable list: seeding, optimistic concurrency, validation,
// and the invariant the whole id-freezing design exists to protect —
// renaming an entry must not lose its tick.
// Run: node test/list.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const SEED = fileURLToPath(new URL("../seed/list.json", import.meta.url));
const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}`;

let dataDir;
let child;

function start() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (buf) => {
      if (buf.toString().includes("listening")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
  });
}

async function stop() {
  if (!child) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await done;
  child = null;
}

const getList = () => fetch(`${BASE}/api/list`).then((r) => r.json());
const putList = (doc) =>
  fetch(`${BASE}/api/list`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
const getState = () => fetch(`${BASE}/api/state`).then((r) => r.json());
const tick = (id, c = true, t = Date.now()) =>
  fetch(`${BASE}/api/state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: [{ id, c, t }] }),
  });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("seeds itself from seed/list.json on first boot", async () => {
  const seed = JSON.parse(await readFile(SEED, "utf8"));
  const live = await getList();
  assert.equal(live.sections.length, seed.sections.length);
  assert.equal(live.rev, 0);
  const seedItems = seed.sections.reduce((n, s) => n + s.items.length, 0);
  const liveItems = live.sections.reduce((n, s) => n + s.items.length, 0);
  assert.equal(liveItems, seedItems);
});

test("the seed carries no HTML entities", async () => {
  // Everything renders through textContent now, so a stored "&ndash;" would
  // show up literally on the page instead of as a dash.
  const live = await getList();
  assert.equal(/&[a-z]+;/.test(JSON.stringify(live.sections)), false);
});

test("every seeded section says which volume collects it", async () => {
  // The whole point of the field: standing in front of a library, you need to
  // know which book this section is in. A blank one is a gap, not a style choice.
  const live = await getList();
  const missing = live.sections.filter((s) => !s.collected || !s.collected.trim());
  assert.deepEqual(missing.map((s) => s.n), [], "sections with no collected-editions text");
});

test("the collected-editions field round-trips", async () => {
  const live = await getList();
  live.sections[0].collected = "Some Omnibus Vol. 1 (2019)";
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 200);
  assert.equal((await getList()).sections[0].collected, "Some Omnibus Vol. 1 (2019)");
});

test("a valid write bumps the revision", async () => {
  const live = await getList();
  live.sections[0].title = "Before the Beginning (edited)";
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.rev, live.rev + 1);
  assert.equal(saved.sections[0].title, "Before the Beginning (edited)");
});

test("a stale write is refused with the current document", async () => {
  // The case this exists for: a phone showing yesterday's list would otherwise
  // delete every section added since.
  const live = await getList();
  const res = await putList({ rev: live.rev - 1, sections: [] });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.rev, live.rev);
  assert.ok(body.sections.length > 0, "409 returns the server's document to reconcile against");
  const after = await getList();
  assert.equal(after.sections.length, live.sections.length, "nothing was written");
});

test("renaming an entry keeps its tick", async () => {
  // The entire reason ids are frozen instead of derived from the text.
  const live = await getList();
  const target = live.sections[0].items[0];
  await tick(target.id, true, Date.now());

  target.s = "Completely Different Title";
  target.i = "#999";
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 200);

  const state = await getState();
  assert.equal(state.items[target.id].c, true, "the tick survived the rename");
  const after = await getList();
  assert.equal(after.sections[0].items[0].s, "Completely Different Title");
  assert.equal(after.sections[0].items[0].id, target.id, "the id did not change");
});

test("deleting an entry drops its tick", async () => {
  const live = await getList();
  const doomed = live.sections[1].items[0];
  await tick(doomed.id, true, Date.now());
  assert.ok((await getState()).items[doomed.id], "precondition: it is ticked");

  live.sections[1].items = live.sections[1].items.filter((it) => it.id !== doomed.id);
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 200);

  const state = await getState();
  assert.equal(state.items[doomed.id], undefined, "the orphan tick was purged");
});

test("a new entry can be added and ticked", async () => {
  const live = await getList();
  const fresh = { id: "x-abc123", s: "Brand New Book", i: "#1", note: "", alt: false };
  live.sections[0].items.push(fresh);
  assert.equal((await putList({ rev: live.rev, sections: live.sections })).status, 200);

  await tick("x-abc123", true, Date.now());
  const state = await getState();
  assert.equal(state.items["x-abc123"].c, true);
});

test("a section can be added and removed", async () => {
  let live = await getList();
  const before = live.sections.length;
  live.sections.push({ id: "x-newsec", n: "011", title: "Added", core: true, flag: false, note: "", items: [] });
  assert.equal((await putList({ rev: live.rev, sections: live.sections })).status, 200);
  live = await getList();
  assert.equal(live.sections.length, before + 1);

  live.sections = live.sections.filter((s) => s.id !== "x-newsec");
  assert.equal((await putList({ rev: live.rev, sections: live.sections })).status, 200);
  assert.equal((await getList()).sections.length, before);
});

test("a duplicate id is refused", async () => {
  const live = await getList();
  const clone = { ...live.sections[0].items[0] };
  live.sections[0].items.push(clone);
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /duplicate/i);
});

test("an entry with no series is refused", async () => {
  const live = await getList();
  live.sections[0].items[0].s = "   ";
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /required/i);
});

test("a malformed id is refused", async () => {
  const live = await getList();
  live.sections[0].items[0].id = "NOT VALID";
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid id/i);
});

test("an over-long field is refused", async () => {
  const live = await getList();
  live.sections[0].items[0].s = "x".repeat(500);
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /exceeds/i);
});

test("control characters are stripped, not rejected", async () => {
  const live = await getList();
  // Built with fromCharCode rather than a literal: a raw control byte in a
  // source file turns it binary, which breaks grep, diffs and editors.
  live.sections[0].items[0].s = "Tidy" + String.fromCharCode(0) + "Title" + String.fromCharCode(7);
  const res = await putList({ rev: live.rev, sections: live.sections });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sections[0].items[0].s, "TidyTitle");
});

test("the list survives a restart", async () => {
  const before = await getList();
  await stop();
  await start();
  const after = await getList();
  assert.equal(after.rev, before.rev);
  assert.equal(after.sections[0].title, before.sections[0].title);
  assert.equal(after.sections.length, before.sections.length);
});

let failed = 0;
dataDir = await mkdtemp(join(tmpdir(), "secret-wars-list-"));
await start();

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

await stop();
await rm(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failing` : `\n${tests.length} passing`);
process.exit(failed ? 1 : 0);
