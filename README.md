# secret-wars

A self-hosted checklist for comic reading orders. Keep several of them, tick
issues off on any device, and edit the lists from the page itself — progress
lives on your own server rather than in one browser's localStorage.

It ships with one worked example, **Road to Secret Wars** (Jonathan Hickman's
*Fantastic Four* and *Avengers*, the event itself, the tie-ins, and everything
downstream — 11 sections, 192 entries, each section annotated with which trade
or omnibus collects it). Use it as-is, copy it as a starting point, or ignore
it and build your own.

<img src="public/apple-touch-icon.png" width="72" alt="">

## Design

One Node process with **zero npm dependencies** — `node:` builtins only, no
build step, no lockfile, nothing to keep patched. The whole app is `server.mjs`
plus a `public/` directory.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/orders` | GET | the library index |
| `/api/orders` | POST | create one: `{title}`, `{seed}`, `{copy}` or `{order}` (import) |
| `/api/validate` | POST | dry run — check a document without saving it |
| `/api/orders/:id` | GET | one order: masthead text + sections |
| `/api/orders/:id` | PUT | replace it, guarded by `rev` |
| `/api/orders/:id` | DELETE | remove it and its ticks |
| `/api/orders/:id/export` | GET | the same document, portable, without ticks |
| `/api/state/:id` | GET | ticks for that order |
| `/api/state/:id` | PATCH | apply tick ops: `{ops: [{id, c, t}]}` |
| `/api/seeds` | GET | the bundled examples you can start from |
| `/healthz` | GET | liveness, used by the container healthcheck |

Under `DATA_DIR`:

- **`orders/<id>.json`** — one reading order: its masthead and its sections.
- **`state.json`** — which issues are ticked, namespaced by order id.

Both are written to a temp file and `rename`d into place, so an unclean
shutdown leaves either the old document or the new one — never half of either.

### Two documents, two concurrency models

They fail differently, so they are handled differently.

**Ticks** change constantly, from several devices. They travel as individual
ops carrying a timestamp and the server merges **per item, last-write-wins**,
so the worst a conflict can cost is the older edit of the same issue. A naive
`PUT` of the whole tick-set would be worse than useless here: a phone that had
the page open with a week-old view would push that view over everything ticked
on the laptop since. Client clocks skewed into the future are clamped to server
time, so one wrong clock can't win every future conflict.

Unsent ops queue in `localStorage` and retry on load, on focus, when the tab
becomes visible, and when the browser comes back online — a tick made
underground lands next time the page sees the network.

**Orders** change rarely and deliberately, so they are written whole under an
optimistic `rev` guard. A stale editor gets a `409` carrying the current
document and reloads, rather than deleting sections it never knew about. These
edits are deliberately *not* queued offline: replaying a whole-document write
later is exactly the stale overwrite the guard exists to prevent.

### Item ids are frozen

Ticks are keyed by item id, so an id must never change. They were originally
derived from the entry's text, which was fine while the list was hardcoded and
would have been quietly destructive once it became editable — every rename
orphaning its own tick.

So ids are assigned once and never recomputed. New entries get a random id
(`x-` plus 8 random bytes). Rename an entry freely; its tick follows. Deleting
an entry deletes its tick with it, so a reused id can never inherit a dead one.

Ticks are namespaced per order, so two orders may reuse an id without
colliding — which is what makes copying an example safe.

## Using it

The dropdown at the top left switches between reading orders. `⋯` opens the
library menu:

- **New** — an empty order, ready for sections
- **From example** — copy a bundled seed into a new order of your own
- **Import file** — a `.json` from anywhere (see *Writing a list* below)
- **Duplicate** — copy the current order, without its ticks. The safe way to
  try a restructure on a list you are midway through
- **Export** — the current order as a portable file, without ticks
- **How to write a list** — opens the authoring guide the app serves at
  `/authoring.md`
- **Delete this one** — the order and every tick on it (the last one is
  protected, so the page always has something to show)

An order with no sections shows what to do next rather than a blank page.

The current order is in the URL (`/#road-to-secret-wars`), so it is
bookmarkable and shareable.

## Editing

*Edit list* in the bottom bar turns on edit mode:

- add, rename or delete an entry (series, issue, note, alternate tint)
- add, retitle or delete a section, set whether it counts toward the main line
  or carries a flagged note
- give a section its **collected editions** — which trade, omnibus or complete
  collection covers it, and the year. Its own field, rendered in mono under the
  note, because it is reference data you scan while hunting for the book
- reorder entries within a section, and reorder sections
- *Title & intro* edits the masthead and the list's own vocabulary: title, the
  accent word printed in red, the eyebrow line, the intro paragraph, the footer
  tagline, the word in the progress readout ("40% **complete**"), and what the
  required and optional halves are called ("main line" / "optional"). A Secret
  Wars list converges on its main line; a completionist run just completes

Changes save immediately. Ticking still works while editing.

## Writing a list outside the app

For anything longer than a few entries it is quicker to write JSON than to
click. The app serves its own guide at **`/authoring.md`** and a JSON Schema at
**`/order.schema.json`** — both are in `public/`, so they ship with the image
and are available on whatever host you run it on.

The short version:

- Only `title` and `sections` are required, and every item needs a series name.
- **Leave the ids out.** They are generated on import. Include them only when
  re-importing an exported file whose ticks you want to keep matching.
- Friendlier field names are accepted and normalised — `series` for `s`,
  `issue` for `i`, `name`/`heading` for `title`, `entries` for `items`, and so
  on. A section or item written as a bare string is read as its title.
- `POST /api/validate` reports what would happen without saving anything:
  section and item counts, how many ids it would generate, and which sections
  have no items.

The guide includes a prompt for generating a list with a model, plus the two
things to check afterwards: **which volume collects what** (stated confidently
and wrongly more often than anything else, and exactly what you rely on in
front of a shelf) and **the order itself**, which is an editorial opinion
rather than a fact.

## Adding your own example

Drop a JSON file in `seed/`. It is offered under *From example* and installed
automatically into an empty data directory — no code change. The shape is what
`/api/orders/:id/export` produces:

```json
{
  "title": "Some Reading Order",
  "titleAccent": "Order",
  "eyebrow": "small line above the title",
  "deck": "the intro paragraph",
  "tagline": "footer text",
  "progressWord": "complete",
  "sections": [
    {
      "id": "s-000", "n": "000", "title": "First Section",
      "core": true, "flag": false, "note": "", "collected": "",
      "items": [{ "id": "x-1", "s": "Some Comic", "i": "#1-5", "note": "", "alt": false }]
    }
  ]
}
```

Ids only need to be unique within the file, and must match `[a-z0-9-]{1,120}`.

## Running it

```bash
DATA_DIR=./data PORT=8087 node server.mjs      # http://localhost:8087
```

Or with Docker:

```bash
docker build -t reading-order .
docker run -d --name reading-order \
  -p 127.0.0.1:8087:8080 \
  -v /srv/reading-order:/data \
  reading-order
```

An empty data directory installs the bundled examples, so a fresh clone is
never blank. A data directory from the single-list version of this app is
migrated in place on first boot, keeping the original as `list.json.migrated`.

**There is no authentication, by design.** These are comic reading lists, and
the gate is the network: bind the container to loopback and put it behind
whatever reverse proxy already fronts your other services. Don't expose it to
the internet without adding a gate — anyone who can reach it can rewrite every
list.

## Development

```bash
node test/page.test.mjs      #  6 assertions — script/markup agreement
node test/sync.test.mjs      # 10 assertions — ticks and merge rules
node test/orders.test.mjs    # 27 assertions — library, editing, import, migration
node --check server.mjs
python3 scripts/make-icon.py # regenerate the iOS home-screen icon (stdlib only)
```

No framework and no dependencies. The two API suites spawn the real server
against a temp directory and talk to it over HTTP; `orders.test.mjs` also
builds a legacy single-list data directory and asserts it migrates.

`page.test.mjs` is static, and exists because the API suites never open the
page: it checks that every id the script looks up is defined in the markup,
that no user text reaches `innerHTML`, and that no single reading order is
hardcoded into the page any more.

CI runs all three, then **builds the image, starts it, and requires it to
answer `/healthz` with a seeded library and serve the page** before publishing.
That gate exists because the unit tests all pass against the source tree, so
they cannot see a file the Dockerfile forgot to copy — which shipped once as a
crash-looping container.

## Known limits

- Fonts load from Google Fonts, so a device with no internet falls back to the
  local stack. Vendoring them into `public/` would make it self-contained.
- No service worker: an interrupted session is handled, but opening the page
  cold with no route to the server shows nothing.
- Single-user. There are no accounts, so everyone who can reach it shares the
  same library and the same ticks.

## Credits

Reading orders are editorial: what to include, in what order, and what is
optional are judgement calls. The bundled example's list and notes are one such
take, stored as plain JSON so it is easy to disagree with. Comics and their
titles are the property of their publishers; nothing here reproduces any of
them.
