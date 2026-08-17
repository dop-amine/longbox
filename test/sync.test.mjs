// Exercises the merge rules the whole multi-device story rests on.
// Run: node test/sync.test.mjs   (no test framework, no dependencies)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const ORDER = "road-to-secret-wars";
const STATE = `${BASE}/api/state/${ORDER}`;

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

const get = () => fetch(STATE).then((r) => r.json());
const patch = (ops) =>
  fetch(STATE, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops }),
  });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("starts with nothing ticked", async () => {
  const state = await get();
  assert.deepEqual(state.items, {});
});

test("a tick is stored", async () => {
  const res = await patch([{ id: "001-avengers-1", c: true, t: 1000 }]);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.items["001-avengers-1"].c, true);
});

test("an older op loses to a newer one", async () => {
  // The device that was offline replays a stale untick; the laptop's later
  // tick must survive. This is the case a whole-state PUT would get wrong.
  await patch([{ id: "002-infinity-1", c: true, t: 5000 }]);
  await patch([{ id: "002-infinity-1", c: false, t: 4000 }]);
  assert.equal((await get()).items["002-infinity-1"].c, true);
});

test("a newer untick wins", async () => {
  await patch([{ id: "002-infinity-1", c: false, t: 6000 }]);
  assert.equal((await get()).items["002-infinity-1"].c, false);
});

test("future timestamps are clamped to now", async () => {
  const future = Date.now() + 86_400_000;
  await patch([{ id: "005-avengers-35", c: true, t: future }]);
  assert.ok((await get()).items["005-avengers-35"].t <= Date.now());
});

test("malformed ops are ignored, not fatal", async () => {
  const res = await patch([
    { id: "BAD ID WITH SPACES", c: true, t: 1 },
    { id: "006-secret-wars-1", c: "yes", t: 1 },
    { id: "006-secret-wars-2", c: true, t: 1 },
  ]);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.items["BAD ID WITH SPACES"], undefined);
  assert.equal(state.items["006-secret-wars-1"], undefined);
  assert.equal(state.items["006-secret-wars-2"].c, true);
});

test("a bad body is a 400, not a crash", async () => {
  const res = await fetch(STATE, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("the page is served", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /Reading Order/i);
});

test("path traversal is refused", async () => {
  const res = await fetch(`${BASE}/../server.mjs`, { redirect: "manual" });
  assert.ok(res.status === 404 || res.status === 403 || res.status === 301);
});

test("ticks survive a restart", async () => {
  await stop();
  await start();
  const state = await get();
  assert.equal(state.items["001-avengers-1"].c, true);
  assert.equal(state.items["002-infinity-1"].c, false);
});

let failed = 0;
dataDir = await mkdtemp(join(tmpdir(), "secret-wars-test-"));
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
