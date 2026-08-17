// Static checks on the page itself. The app builds its DOM by hand, so the
// script and the markup have to agree about element ids — and a typo there is
// invisible to the API tests, which never open the page.
// Run: node test/page.test.mjs

import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const matchAll = (re) => [...html.matchAll(re)].map((m) => m[1]);

test("every element the script looks up actually exists in the markup", async () => {
  const defined = new Set(matchAll(/id="([^"]+)"/g));
  const referenced = new Set([
    ...matchAll(/getElementById\("([^"]+)"\)/g),
    ...matchAll(/getElementById\('([^']+)'\)/g),
  ]);
  const missing = [...referenced].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `script looks up ids that no element defines: ${missing.join(", ")}`);
  assert.ok(referenced.size > 10, "expected the script to drive the page by id");
});

test("the controls the app needs are present", async () => {
  // If one of these is renamed without updating the script, the feature simply
  // stops working with no error anywhere.
  for (const id of [
    "orderSelect", "libBtn", "libMenu", "newBtn", "exampleBtn", "importBtn",
    "exportBtn", "deleteOrderBtn", "importFile", "seedRow",
    "mastTitle", "eyebrow", "deck", "tagline", "sectionRange",
    "sections", "saveState", "editBtn", "editMetaBtn", "resetBtn",
    "count", "pctLabel", "barFill", "dockMain", "dockOpt",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing element: ${id}`);
  }
});

test("user text never goes through innerHTML", async () => {
  // Everything on this page is user-editable now. The one permitted use is the
  // progress counter, which interpolates two numbers and no user input.
  const uses = [...html.matchAll(/\.innerHTML\s*=/g)];
  assert.equal(uses.length, 1, `expected exactly one innerHTML assignment, found ${uses.length}`);
  const line = html.slice(0, uses[0].index).split("\n").pop() + html.slice(uses[0].index).split("\n")[0];
  assert.match(line, /getElementById\("count"\)/, "the only innerHTML assignment should be the counter");
  assert.doesNotMatch(line, /\bit\.|\bsec\.|order\./, "the counter must not interpolate list content");
});

test("the assets the page references are shipped", async () => {
  const refs = [
    ...matchAll(/<link[^>]+href="(\/[^"]+)"/g),
    ...matchAll(/<img[^>]+src="(\/[^"]+)"/g),
  ].filter((href) => !href.startsWith("//"));
  for (const ref of new Set(refs)) {
    await access(new URL("." + ref, `file://${PUBLIC}`)).catch(() => {
      throw new Error(`page references ${ref}, which is not in public/`);
    });
  }
});

test("the page carries no raw control bytes", async () => {
  // A stray control byte turns the file binary, which breaks grep and diffs.
  const bad = [...html].filter((ch) => {
    const c = ch.codePointAt(0);
    return c < 9 || (c > 13 && c < 32) || c === 127;
  });
  assert.equal(bad.length, 0, `${bad.length} control characters in index.html`);
});

test("nothing about one particular reading order is hardcoded", async () => {
  // The masthead comes from the order document now; the page is generic.
  const body = html.slice(html.indexOf("<body"));
  assert.doesNotMatch(body, /Road to Secret Wars/, "the page hardcodes an order title");
  assert.doesNotMatch(body, /Hickman/, "the page hardcodes an order's eyebrow text");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}
console.log(failed ? `\n${failed} failing` : `\n${tests.length} passing`);
process.exit(failed ? 1 : 0);
