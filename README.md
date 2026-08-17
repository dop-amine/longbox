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
| `/api/state` | GET | current state: `{rev, updated, items: {<id>: {c, t}}}` |
| `/api/state` | PATCH | apply ops: `{ops: [{id, c, t}]}`, returns new state |
| `/healthz` | GET | liveness, used by the container healthcheck |

State is a single JSON document at `$DATA_DIR/state.json`, written to a temp
file and `rename`d into place, so an unclean shutdown leaves either the old
state or the new one — never half of either.

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

### Item ids come from the text

An id is `slug(section + series + issue)` — e.g. `002-infinity-1`. **Editing an
existing entry's series or issue text changes its id and orphans its tick.**
Adding entries is free; renaming an existing one is not. If a rename is
unavoidable, either re-tick by hand or rewrite the id inside `state.json`.

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
node test/sync.test.mjs      # 10 assertions, no framework, no dependencies
node --check server.mjs
python3 scripts/make-icon.py # regenerate the iOS home-screen icon (stdlib only)
```

The tests spawn the real server against a temp directory and cover the merge
rules the multi-device story rests on: stale ops losing to newer ones, future
timestamps being clamped, malformed ops being ignored rather than fatal, and
state surviving a restart.

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
