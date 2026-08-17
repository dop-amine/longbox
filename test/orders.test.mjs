// Exercises the library of reading orders: seeding, per-order isolation,
// optimistic concurrency, validation, import/export, and the invariant the
// whole id-freezing design exists to protect — renaming an entry keeps its tick.
// Run: node test/orders.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const SEED_DIR = fileURLToPath(new URL("../seed/", import.meta.url));
const PORT = 8098;
const BASE = `http://127.0.0.1:${PORT}`;
const EXAMPLE = "road-to-secret-wars";

let dataDir;
let child;

function start(dir = dataDir) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir },
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

const json = (path, options) => fetch(BASE + path, options).then((r) => r.json());
const raw = (path, options) => fetch(BASE + path, options);
const getOrder = (id = EXAMPLE) => json(`/api/orders/${id}`);
const putOrder = (doc, id = doc.id) =>
  raw(`/api/orders/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
const post = (body) =>
  raw("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const tick = (id, itemId, c = true, t = Date.now()) =>
  raw(`/api/state/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: [{ id: itemId, c, t }] }),
  });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("an empty data directory installs the bundled examples", async () => {
  const seeds = (await readdir(SEED_DIR)).filter((f) => f.endsWith(".json"));
  const index = await json("/api/orders");
  assert.equal(index.length, seeds.length);
  assert.ok(index.some((o) => o.id === EXAMPLE), `expected ${EXAMPLE} in ${index.map((o) => o.id)}`);
});

test("the example carries its own masthead", async () => {
  // A reading order owns its title and intro; nothing about Secret Wars is
  // hardcoded in the page any more.
  const order = await getOrder();
  assert.equal(order.title, "Road to Secret Wars");
  assert.equal(order.titleAccent, "Secret Wars");
  assert.ok(order.deck.length > 20, "the example should ship an intro paragraph");
  assert.equal(order.progressWord, "convergence");
});

test("the example is intact: 11 sections, 192 entries, all annotated", async () => {
  const order = await getOrder();
  assert.equal(order.sections.length, 11);
  assert.equal(order.sections.reduce((n, s) => n + s.items.length, 0), 192);
  const blank = order.sections.filter((s) => !s.collected || !s.collected.trim());
  assert.deepEqual(blank.map((s) => s.n), [], "sections with no collected-editions text");
});

test("a valid write bumps the revision", async () => {
  const order = await getOrder();
  order.sections[0].title = "Before the Beginning (edited)";
  const res = await putOrder(order);
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.rev, order.rev + 1);
  assert.equal(saved.sections[0].title, "Before the Beginning (edited)");
});

test("a stale write is refused with the current document", async () => {
  const order = await getOrder();
  const res = await putOrder({ ...order, rev: order.rev - 1, sections: [] });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.rev, order.rev);
  assert.ok(body.sections.length > 0, "409 returns the server's document to reconcile against");
  assert.equal((await getOrder()).sections.length, order.sections.length, "nothing was written");
});

test("renaming an entry keeps its tick", async () => {
  const order = await getOrder();
  const target = order.sections[0].items[0];
  await tick(EXAMPLE, target.id);

  target.s = "Completely Different Title";
  target.i = "#999";
  assert.equal((await putOrder(order)).status, 200);

  const state = await json(`/api/state/${EXAMPLE}`);
  assert.equal(state.items[target.id].c, true, "the tick survived the rename");
  const after = await getOrder();
  assert.equal(after.sections[0].items[0].id, target.id, "the id did not change");
});

test("deleting an entry drops its tick", async () => {
  const order = await getOrder();
  const doomed = order.sections[1].items[0];
  await tick(EXAMPLE, doomed.id);
  assert.ok((await json(`/api/state/${EXAMPLE}`)).items[doomed.id], "precondition: ticked");

  order.sections[1].items = order.sections[1].items.filter((it) => it.id !== doomed.id);
  assert.equal((await putOrder(order)).status, 200);
  assert.equal((await json(`/api/state/${EXAMPLE}`)).items[doomed.id], undefined);
});

test("a new empty order can be created and edited", async () => {
  const res = await post({ title: "My Other List" });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.id, "my-other-list");
  assert.equal(created.sections.length, 0);
  assert.equal(created.progressWord, "complete", "a sane default when none is given");

  created.sections.push({
    id: "x-sec1", n: "01", title: "First", core: true, flag: false, note: "", collected: "",
    items: [{ id: "x-item1", s: "Some Comic", i: "#1", note: "", alt: false }],
  });
  assert.equal((await putOrder(created)).status, 200);
  assert.equal((await getOrder("my-other-list")).sections[0].items[0].s, "Some Comic");
});

test("ticks are namespaced per order", async () => {
  // Two orders may legitimately reuse an item id; a tick on one must not
  // appear on the other.
  const shared = "x-item1";
  await tick("my-other-list", shared);

  const other = await json("/api/state/my-other-list");
  const example = await json(`/api/state/${EXAMPLE}`);
  assert.equal(other.items[shared].c, true);
  assert.equal(example.items[shared], undefined, "the tick leaked into another order");
});

test("a new order can be started from a bundled example", async () => {
  const seeds = await json("/api/seeds");
  assert.ok(seeds.length >= 1);
  assert.ok(seeds[0].items > 0, "the seed index reports its size");

  const res = await post({ seed: EXAMPLE });
  assert.equal(res.status, 201);
  const copy = await res.json();
  assert.notEqual(copy.id, EXAMPLE, "a copy gets its own id");
  assert.equal(copy.sections.length, 11);
  assert.equal(copy.rev, 0);
});

test("export omits ticks and re-imports as a separate order", async () => {
  const res = await raw(`/api/orders/${EXAMPLE}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment/);
  const doc = await res.json();
  assert.equal(doc.rev, undefined, "a portable list carries no revision");
  assert.equal(doc.updated, undefined);
  assert.ok(doc.title && doc.sections.length, "but does carry the masthead and content");

  const imported = await (await post({ order: doc })).json();
  assert.notEqual(imported.id, EXAMPLE);
  assert.equal(imported.sections.length, doc.sections.length);
});

test("deleting an order removes it and its ticks", async () => {
  const before = await json("/api/orders");
  const res = await raw("/api/orders/my-other-list", { method: "DELETE" });
  assert.equal(res.status, 200);
  const after = await json("/api/orders");
  assert.equal(after.length, before.length - 1);
  assert.equal((await raw("/api/orders/my-other-list")).status, 404);
  assert.equal((await raw("/api/state/my-other-list")).status, 404);
});

test("the last remaining order cannot be deleted", async () => {
  // Deleting into an empty library would leave the page with nothing to show
  // and no obvious way back.
  const index = await json("/api/orders");
  for (const entry of index.slice(1)) {
    await raw(`/api/orders/${entry.id}`, { method: "DELETE" });
  }
  const remaining = await json("/api/orders");
  assert.equal(remaining.length, 1);
  const res = await raw(`/api/orders/${remaining[0].id}`, { method: "DELETE" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /only reading order/i);
});

test("the progress vocabulary belongs to the order", async () => {
  // "convergence" and "main line" are this list's words, not the app's.
  const order = await getOrder();
  assert.equal(order.mainLabel, "main line", "a default is supplied");
  order.progressWord = "read";
  order.mainLabel = "the run";
  order.optionalLabel = "extras";
  assert.equal((await putOrder(order)).status, 200);
  const saved = await getOrder();
  assert.equal(saved.progressWord, "read");
  assert.equal(saved.mainLabel, "the run");
  assert.equal(saved.optionalLabel, "extras");

  saved.progressWord = "";
  saved.mainLabel = "";
  const back = await (await putOrder(saved)).json();
  assert.equal(back.progressWord, "complete", "blank falls back to a default");
  assert.equal(back.mainLabel, "main line");
});

test("an import without ids is accepted and ids are generated", async () => {
  // The single most common thing an author or a model leaves out.
  const res = await post({
    order: {
      title: "No Ids Here",
      sections: [{ title: "One", items: [{ s: "A Comic", i: "#1" }, { s: "Another" }] }],
    },
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.sections[0].items.length, 2);
  for (const it of created.sections[0].items) {
    assert.match(it.id, /^x-[0-9a-f-]+$/, "a usable id was generated");
  }
  assert.equal(created.sections[0].core, true, "sections count toward the main line by default");
});

test("an import using friendlier field names still works", async () => {
  const res = await post({
    order: {
      name: "Aliased",
      intro: "written by someone who did not read the field list",
      sections: [
        {
          heading: "Part One",
          number: "01",
          notes: "a note",
          volumes: "Some Omnibus (2020)",
          required: false,
          entries: [{ series: "Sandman", issue: "#1-8", comment: "start here" }],
        },
      ],
    },
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.title, "Aliased");
  assert.ok(created.deck.startsWith("written by"));
  const sec = created.sections[0];
  assert.equal(sec.title, "Part One");
  assert.equal(sec.n, "01");
  assert.equal(sec.note, "a note");
  assert.equal(sec.collected, "Some Omnibus (2020)");
  assert.equal(sec.core, false);
  assert.equal(sec.items[0].s, "Sandman");
  assert.equal(sec.items[0].i, "#1-8");
  assert.equal(sec.items[0].note, "start here");
});

test("a section or item written as a bare string is understood", async () => {
  const res = await post({
    order: { title: "Terse", sections: [{ title: "Part", items: ["First Series", "Second Series"] }] },
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.deepEqual(created.sections[0].items.map((i) => i.s), ["First Series", "Second Series"]);
});

test("validate reports on a document without saving it", async () => {
  const before = (await json("/api/orders")).length;
  const report = await json("/api/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      order: { title: "Dry Run", sections: [{ title: "Full", items: [{ s: "X" }] }, { title: "Empty" }] },
    }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.sections, 2);
  assert.equal(report.items, 1);
  assert.ok(report.generatedIds >= 3, "ids it would generate are counted");
  assert.deepEqual(report.emptySections, ["Empty"], "a section with no items is worth flagging");
  assert.equal((await json("/api/orders")).length, before, "nothing was created");
});

test("validate explains what is wrong instead of throwing", async () => {
  const report = await json("/api/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: { title: "Broken", sections: [{ title: "S", items: [{ i: "#1" }] }] } }),
  });
  assert.equal(report.ok, false);
  assert.match(report.error, /series is required/i);
});

test("an order can be duplicated, without its ticks", async () => {
  const source = await getOrder();
  const ticked = source.sections[0].items[1];
  await tick(EXAMPLE, ticked.id);

  const res = await post({ copy: EXAMPLE, title: "A Working Copy" });
  assert.equal(res.status, 201);
  const copy = await res.json();
  assert.equal(copy.title, "A Working Copy");
  assert.equal(copy.sections.length, source.sections.length);
  assert.equal(copy.rev, 0);

  const copyState = await json(`/api/state/${copy.id}`);
  assert.deepEqual(copyState.items, {}, "a copy starts unread");
  const original = await json(`/api/state/${EXAMPLE}`);
  assert.ok(original.items[ticked.id].c, "the original keeps its ticks");
});

test("a duplicate id is refused", async () => {
  const order = await getOrder();
  order.sections[0].items.push({ ...order.sections[0].items[0] });
  const res = await putOrder(order);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /duplicate/i);
});

test("an entry with no series is refused", async () => {
  const order = await getOrder();
  order.sections[0].items[0].s = "   ";
  const res = await putOrder(order);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /required/i);
});

test("an order with no title is refused", async () => {
  const order = await getOrder();
  order.title = "";
  const res = await putOrder(order);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /title is required/i);
});

test("control characters are stripped, not rejected", async () => {
  // Built with fromCharCode rather than a literal: a raw control byte in a
  // source file turns it binary, which breaks grep, diffs and editors.
  const order = await getOrder();
  order.sections[0].items[0].s = "Tidy" + String.fromCharCode(0) + " Title";
  const res = await putOrder(order);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sections[0].items[0].s, "Tidy Title");
});

test("an unknown order is a 404, not a crash", async () => {
  assert.equal((await raw("/api/orders/no-such-list")).status, 404);
  assert.equal((await raw("/api/state/no-such-list")).status, 404);
});

test("everything survives a restart", async () => {
  const before = await json("/api/orders");
  const beforeState = await json(`/api/state/${EXAMPLE}`);
  await stop();
  await start();
  assert.deepEqual((await json("/api/orders")).map((o) => o.id), before.map((o) => o.id));
  assert.deepEqual(await json(`/api/state/${EXAMPLE}`), beforeState);
});

// The single-list layout this app shipped with, converted in place on boot.
test("a legacy single-list data directory migrates", async () => {
  await stop();
  const legacyDir = await mkdtemp(join(tmpdir(), "secret-wars-legacy-"));
  const seed = JSON.parse(await readFile(join(SEED_DIR, `${EXAMPLE}.json`), "utf8"));
  const firstItem = seed.sections[0].items[0].id;

  await writeFile(
    join(legacyDir, "list.json"),
    JSON.stringify({ rev: 7, updated: Date.now(), sections: seed.sections })
  );
  await writeFile(
    join(legacyDir, "state.json"),
    JSON.stringify({ rev: 3, updated: Date.now(), items: { [firstItem]: { c: true, t: 1000 } } })
  );

  await start(legacyDir);
  try {
    const index = await json("/api/orders");
    assert.equal(index.length, 1, "the legacy list becomes exactly one order");
    const id = index[0].id;
    assert.equal(index[0].title, "Road to Secret Wars", "it keeps the example's identity");

    const order = await getOrder(id);
    assert.equal(order.rev, 7, "the revision carries over");
    assert.equal(order.sections.length, seed.sections.length);

    const state = await json(`/api/state/${id}`);
    assert.equal(state.items[firstItem].c, true, "existing ticks survive, namespaced");

    const files = await readdir(legacyDir);
    assert.ok(files.includes("list.json.migrated"), "the original is kept as a backup");
    assert.ok(!files.includes("list.json"), "and is not re-migrated on the next boot");
  } finally {
    await stop();
    await rm(legacyDir, { recursive: true, force: true });
    await start();
  }
});

let failed = 0;
dataDir = await mkdtemp(join(tmpdir(), "secret-wars-orders-"));
await mkdir(dataDir, { recursive: true });
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
