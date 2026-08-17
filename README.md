# secret-wars

A self-hosted reading checklist for the road to Secret Wars — Jonathan
Hickman's *Fantastic Four* and *Avengers*, the event itself, the tie-ins worth
reading, and everything downstream.

Tick issues off on any device. Progress lives on your own server, not in a
browser's localStorage, so the phone and the laptop agree.

<img src="public/apple-touch-icon.png" width="72" alt="">

## Design

One Node process with **zero npm dependencies** — `node:` builtins only, no
build step, no lockfile, nothing to keep patched. The whole app is `server.mjs`
plus a `public/` directory.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/state` | GET | ticks: `{rev, updated, items: {<id>: {c, t}}}` |
| `/api/state` | PATCH | apply tick ops: `{ops: [{id, c, t}]}`, returns new state |
| `/api/list` | GET | the reading order: `{rev, updated, sections: [...]}` |
| `/api/list` | PUT | replace the reading order, guarded by `rev` |
| `/healthz` | GET | liveness, used by the container healthcheck |

Two JSON documents live in `$DATA_DIR`, and the split is the central idea:

- **`list.json`** — the reading order itself. Edited rarely and deliberately.
- **`state.json`** — which issues are ticked. Edited constantly, from anywhere.

Both are written to a temp file and `rename`d into place, so an unclean
shutdown leaves either the old document or the new one — never half of either.

They have different concurrency models because they have different failure
modes. Ticks merge per item, so two devices can never revert each other. List
edits are whole-document writes guarded by a revision number: if the server has
moved on, the write is refused with a `409` carrying the current document, and
the page reloads rather than clobbering a change made elsewhere.

`list.json` is seeded from `seed/list.json` (shipped in the image) the first
time the service starts against an empty data directory.

### Why ops instead of saving the whole checklist

The obvious design is `PUT /api/state` with the full set of ticked issues. It
is also wrong for the only feature that matters here. A phone with the page
open holds a view of the world from whenever it last loaded; if it saves that
view, it silently reverts everything ticked on the laptop in the meantime.

So a tick travels as an individual op carrying a timestamp, and the server
merges **per item, last-write-wins**. The worst a conflict can cost is the
older edit of the same issue. Client clocks skewed into the future are clamped
to server time, so one device with a wrong clock can't win every future
conflict against every other device.

Unsent ops are queued in `localStorage` and retried on load, on focus, when the
tab becomes visible, and when the browser reports it is back online — so a tick
made underground lands the next time the page sees the network. The last known
state is mirrored locally too, so the page paints instantly instead of waiting
on a round trip, and still shows progress when the server is unreachable.

### Item ids are frozen

Ticks are keyed by item id, so an id must never change. Originally they were
derived from the entry's text (`slug(section + series + issue)`), which was
fine while the list was hardcoded and fatal as soon as it became editable —
renaming an issue would have silently orphaned its tick.

So `seed/list.json` pins the ids that scheme produced, and nothing recomputes
them again. New entries get a random id (`x-` plus 8 random bytes). An id,
once assigned, outlives every edit to the row: rename an entry freely, its
tick follows.

Deleting an entry deletes its tick with it. That is deliberate — a tick left
behind for a row that no longer exists would come back to life if the same id
were ever reused.

## Editing the list

*Edit list* in the bottom bar turns on edit mode. From there you can:

- add, rename or delete an entry (series, issue, note, alternate tint)
- add, retitle or delete a section, and set whether it counts toward the main
  line or carries a flagged note
- reorder entries within a section, and reorder sections

Changes save immediately. Ticking still works while editing.

Unlike ticks, list edits are **not** queued when offline: replaying a
whole-document write later is exactly the stale overwrite the revision guard
exists to prevent. If a save fails, the page reloads from the server and says
so rather than pretending it worked.

## Running it

```bash
DATA_DIR=./data PORT=8087 node server.mjs      # http://localhost:8087
```

Or with Docker:

```bash
docker build -t secret-wars .
docker run -d --name secret-wars \
  -p 127.0.0.1:8087:8080 \
  -v /srv/secret-wars:/data \
  secret-wars
```

**There is no authentication, by design.** It is a comics reading list, and the
gate is the network: bind the container to loopback and put it behind whatever
reverse proxy already fronts your other services. Don't expose it to the
internet without adding a gate first — anyone who can reach it can rewrite your
progress.

## Development

```bash
node test/sync.test.mjs      # 10 assertions — ticks and merge rules
node test/list.test.mjs      # 14 assertions — editing, validation, concurrency
node --check server.mjs
python3 scripts/make-icon.py # regenerate the iOS home-screen icon (stdlib only)
```

No framework and no dependencies: both suites spawn the real server against a
temp directory and talk to it over HTTP.

`sync.test.mjs` covers the merge rules the multi-device story rests on — stale
ops losing to newer ones, future timestamps clamped, malformed ops ignored
rather than fatal, state surviving a restart.

`list.test.mjs` covers editing: seeding from the shipped seed, revision
conflicts refusing a stale write, validation (duplicate ids, missing series,
over-long fields), orphan ticks purged on delete, and the invariant the whole
id-freezing design exists to protect — **renaming an entry keeps its tick**.

CI runs those on every push and publishes a container image on merge to `main`.

## Known limits

- Fonts are loaded from Google Fonts, so a device with no internet falls back
  to the local stack (Impact / system sans-serif / Menlo). Vendoring them into
  `public/` would make it fully self-contained.
- No service worker: an interrupted session is handled, but opening the page
  cold with no route to the server shows nothing.
- Single-user. There are no accounts, so everyone who can reach it shares one
  checklist.

## Credits

The reading order is a curated list — sections, issue ordering, and the notes
on what is optional are editorial calls, collected in `public/index.html` as a
plain `DATA` array so they're easy to amend. Comics and their titles are the
property of Marvel; nothing here reproduces any of it.
