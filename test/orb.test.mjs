// Jarvis's orb (optional, JARVIS_ORB_ORIGIN): the page and its CSP gain exactly
// the loader, the element and that one origin — and nothing at all when unset.
// Run: node test/orb.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "https://jarvis.example.test";

function start(env) {
  return new Promise(async (resolve, reject) => {
    const dir = await mkdtemp(join(tmpdir(), "longbox-orb-"));
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, JARVIS_ORB_ORIGIN: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (b) => (err += b));
    child.stdout.on("data", (b) => {
      if (b.toString().includes("listening")) resolve({ child, dir });
    });
    child.on("exit", (code) => reject(Object.assign(new Error(`exited ${code}`), { code, err })));
    setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
  });
}

async function stop({ child, dir }) {
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
  await rm(dir, { recursive: true, force: true });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("unset: the page and its CSP are exactly as before — no orb, no Jarvis origin", async () => {
  const s = await start({});
  try {
    const res = await fetch(BASE + "/");
    const html = await res.text();
    const csp = res.headers.get("content-security-policy");
    assert.ok(!html.includes("jarvis-orb"));
    assert.equal(
      csp,
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  } finally {
    await stop(s);
  }
});

test("set: the loader (async, classic), the element and the dock lift, before </body> — and nothing else changes", async () => {
  const s = await start({ JARVIS_ORB_ORIGIN: ORIGIN + "/" });
  try {
    const html = await (await fetch(BASE + "/")).text();
    // Exactly one insertion, before the page's last </body>: the rest is the file, byte for byte.
    const file = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const at = file.lastIndexOf("</body>");
    assert.ok(html.startsWith(file.slice(0, at)));
    assert.ok(html.endsWith(file.slice(at)));
    assert.equal((await (await fetch(BASE + "/index.html")).text()), html);
    assert.ok(html.includes(`<script src="${ORIGIN}/embed/jarvis.js" async></script>`));
    assert.ok(!html.includes('type="module"'));
    assert.ok(html.includes('<jarvis-orb position="bottom-right" size="sm" mode="auto"></jarvis-orb>'));
    assert.ok(html.includes("--jarvis-orb-lift"));
    assert.ok(html.includes("document.body.style.paddingBottom=(d.offsetHeight+80)+'px'"));
    assert.ok(html.indexOf("jarvis-orb") < html.indexOf("</body>"));
    assert.equal(html.split("<jarvis-orb ").length - 1, 1);
  } finally {
    await stop(s);
  }
});

test("set: the CSP gains that one origin for script-src and frame-src, and loosens nothing else", async () => {
  const s = await start({ JARVIS_ORB_ORIGIN: ORIGIN });
  try {
    const csp = (await fetch(BASE + "/")).headers.get("content-security-policy");
    assert.ok(csp.includes(`script-src 'self' 'unsafe-inline' ${ORIGIN};`));
    assert.ok(csp.includes(`frame-src ${ORIGIN};`));
    assert.ok(csp.includes("connect-src 'self';"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.equal(csp.split(ORIGIN).length - 1, 2);
  } finally {
    await stop(s);
  }
});

test("a value that is not an https origin stops the server at start", async () => {
  for (const bad of [
    "http://jarvis.example.test",
    "https://jarvis.example.test/embed",
    "jarvis.example.test",
    "https://x;script-src", // would add a CSP directive
    'https://a"b', // would break out of the script's src attribute
  ]) {
    await assert.rejects(start({ JARVIS_ORB_ORIGIN: bad }), (e) => e.code !== 0 && /https origin/.test(e.err), bad);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
