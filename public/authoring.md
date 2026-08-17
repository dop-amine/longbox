# Writing a reading order

A reading order is one JSON file. You can write it by hand, generate it with a
model, or export an existing one and edit it. Import it with **⋯ → Import
file**, and it becomes a new list with its own progress.

You can also build a list entirely in the page (**Edit list**) and never touch
JSON at all. This guide is for when you want to produce one in bulk.

---

## The shape

```json
{
  "title": "My Reading Order",
  "titleAccent": "Order",
  "eyebrow": "a small line above the title",
  "deck": "One paragraph explaining what this list is and how to use it.",
  "tagline": "shown in the footer",
  "progressWord": "complete",
  "mainLabel": "main line",
  "optionalLabel": "optional",
  "sections": [
    {
      "n": "001",
      "title": "Where It Starts",
      "core": true,
      "flag": false,
      "note": "One or two sentences about this stretch.",
      "collected": "Which book collects it, and the year.",
      "items": [
        { "s": "Some Series", "i": "#1-6", "note": "why it matters", "alt": false },
        { "s": "Another Series", "i": "#1" }
      ]
    }
  ]
}
```

Only `title` and `sections` are required, and every item needs a series name.
Everything else has a sensible default.

### What each field does

| Field | Where it shows |
|---|---|
| `title` | the masthead, and the browser tab |
| `titleAccent` | the tail of the title, printed in red on its own line. `"Road to Secret Wars"` + accent `"Secret Wars"` renders as *Road to* / **Secret Wars** |
| `eyebrow` | small line above the title |
| `deck` | the intro paragraph |
| `tagline` | bottom-right of the footer |
| `progressWord` | the readout: "40% *complete*" — say `converging`, `read`, whatever fits |
| `mainLabel` | what the required part is called: "main line", "the run", "canon" |
| `optionalLabel` | what everything else is called: "optional", "side reading" |

### Sections

| Field | Meaning |
|---|---|
| `n` | the number printed to the left. Any string — `"001"`, `"1"`, `"Act I"` |
| `title` | the section heading |
| `core` | `true` if it counts toward the main-line percentage. Defaults to `true` |
| `flag` | `true` draws a red bar beside the note, for a warning or an aside |
| `note` | prose: what this stretch is |
| `collected` | reference data: which trade or omnibus collects it, and the year. Rendered in mono, separately from the note, because you scan it while hunting for the book |

### Items

| Field | Meaning |
|---|---|
| `s` | the series name — the only required field |
| `i` | the issue or range: `"#1"`, `"#1-6"`, `"(2015) #1-5"` |
| `note` | a short line under the title |
| `url` | where to actually read it — a link to your comic server, a store page, anything. Must be `http` or `https`. Shows as a **read** button on the row |
| `alt` | `true` tints the row blue. Useful when two titles alternate |

---

## Ids

Every section and item has an id, and **ticks are stored against that id**. That
is why renaming an entry keeps its tick: the id never changes.

**You do not have to write ids.** Leave them out and they are generated on
import. Only include them if you are editing a file you exported and want the
existing ticks to keep matching — in that case, keep the ids exactly as they
are.

Ids must be unique within the file and match `[a-z0-9-]{1,120}`. Anything
missing, malformed or duplicated is replaced with a generated one.

---

## Friendly field names

You do not have to use the short names. These are all accepted and normalised
on import:

- **top level** — `name` → `title`, `intro`/`description`/`subtitle` → `deck`, `kicker` → `eyebrow`
- **section** — `name`/`heading` → `title`, `number` → `n`, `notes`/`description` → `note`, `editions`/`volumes` → `collected`, `entries`/`issues`/`comics` → `items`, `main`/`required` → `core`
- **item** — `series`/`name`/`comic` → `s`, `issue`/`number` → `i`, `comment` → `note`

A section or item written as a plain string is read as its title/series, so
this works:

```json
{ "title": "Quick List", "sections": [
  { "title": "Part One", "items": ["First Series", "Second Series"] }
] }
```

---

## Check it before you import

`POST /api/validate` tells you what would happen, without saving anything:

```bash
curl -sX POST http://your-host/api/validate \
  -H 'content-type: application/json' \
  --data-binary @my-list.json
```

```json
{ "ok": true, "title": "My Reading Order", "sections": 4, "items": 62,
  "generatedIds": 66, "emptySections": [] }
```

`ok: false` comes with an `error` naming the field that is wrong. `emptySections`
lists sections with no items, which is usually a mistake.

---

## Asking a model for one

Models are good at this, because a reading order is mostly recall plus
structure. Give it the shape and let it skip the ids.

> Produce a JSON reading order for **[subject]**, matching this shape exactly:
>
> ```json
> { "title": "", "titleAccent": "", "eyebrow": "", "deck": "",
>   "progressWord": "complete", "mainLabel": "main line", "optionalLabel": "optional",
>   "sections": [ { "n": "001", "title": "", "core": true, "note": "", "collected": "",
>                   "items": [ { "s": "", "i": "", "note": "" } ] } ] }
> ```
>
> Rules:
> - Do not invent ids; leave them out entirely.
> - One item per collected run of issues, with the issue range in `i`.
> - `s` is the series name only. Put the year in `i` when the title has been
>   relaunched, e.g. `"(2015) #1-5"`, because titles repeat across decades.
> - Group into sections that read as a sequence. `core: false` for side reading.
> - `note` on an item is one short line, and only when it is not obvious.
> - `collected` names the trade or omnibus and the year, so a section can be
>   matched to a book on a shelf. Say so plainly if you are unsure which volume.
> - Do not summarise plots or spoil anything.
> - Output JSON only.

Two things worth doing afterwards, whoever wrote it:

- **Check the volume claims.** Which trade collects which issues is exactly the
  sort of detail that gets stated confidently and wrongly. It is also the
  detail you will rely on while standing in front of your library.
- **Read the order itself.** A model will happily produce a plausible sequence
  that no one actually recommends. The list is an editorial opinion; make sure
  it is one you agree with.

---

## Editing an exported file

**⋯ → Export** gives you the current list as JSON, without ticks. Edit it and
import it back and you get a *second* list — importing never overwrites an
existing one. To change a list in place, edit it in the page.
