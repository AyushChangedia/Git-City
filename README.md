# Git City

**Paste a GitHub repo URL and watch its history build itself, commit by commit, as a 3D city.**

Every file is a building. Every folder is a district. Top-level folders sit on
opposite banks of a river. A building's height is its line count, its windows
light up at dusk, and it glows orange the moment a commit touches it, cooling
back to slate over the next twenty commits. Play it back and you can see a
codebase grow, sprawl, get refactored, and lose whole neighbourhoods to a
delete.

! [Git City at dusk: the axios repository as a river city, windows lit, haze on the horizon](docs/screenshot.png)

> ** Demo GIF placeholder** — drop a recording at `docs/demo.gif` and swap the
> image above for `![Git City](docs/demo.gif)`.

**[▶ Live demo](https://ayushchangedia.github.io/Git-City/)** · no build step,
no backend, no install.

---

## What it does

- **Three bundled repos** replay instantly with **zero API calls** — the commit
  data is pre-generated and committed to `data/`.
- **Any public repo** can be fetched live, capped at the 300 most recent
  commits, with an optional token field.
- **Roughly 45 seconds** of playback regardless of repo size, scrubbable, at
  0.5×–4× speed.
- **Everything runs in the browser.** No server, no bundler, no framework.
- **Rendered at sunset** on an island: physical sky, real water, long shadows,
  lit windows and bloom — see [Look and lighting](#look-and-lighting).

## Controls

| | |
|---|---|
| `space` | play / pause |
| `d` | toggle the debug panel (FPS, draw calls, triangles, filler count, camera, bounding box) |
| drag | orbit — this also pauses the slow auto-orbit |
| scroll | zoom |
| scrubber | jump anywhere in history |

`?demo=data/axios-axios.json` or `?repo=owner/name` in the URL skips straight to
a dataset.

---

## How it works

### Buildings

One building per file path, standing on the ground at `y = 0`.

```
footprint      3 x 3 units, 1 unit gap  ->  4 unit pitch
height         clamp(lines / 12, 2, 70)
colour         #4a5568, tinted 45% towards #ff6b35 when just touched,
               cooling back over 20 commits
```

Anything over 30 units is built as three stacked boxes, each 85% the width of
the one below — a setback taper. A single extruded box is a bar on a chart at
any size; a taper is a tower. Mid-rise buildings get a little deterministic
rooftop clutter, and the three tallest files in the whole history carry a spire
with a red aircraft-warning light.

Growth, height changes and demolition all animate over 300ms with an ease-out
cubic. The segments are re-laid every frame of the tween rather than the group
being scaled, so the setbacks keep their proportions and the window rows keep
their physical size the whole way up.

### Districts and the river

Files are grouped by folder. Inside a district, buildings pack into a grid of
`ceil(sqrt(n))` columns.

Top-level folders are then dealt alternately onto two banks, largest first, so
neither side swallows the repository. Each bank packs its districts into a grid
that is deliberately twice as wide as a square packing would be, so it spreads
along the water instead of retreating from it, and row 0 fronts the channel.
The river is 90 units across, with an embankment lip on each side.

The layout is computed once per dataset over **every path the history will ever
contain**, not just the files that exist at the current commit. Each file keeps
one plot for the whole run, and every plot is plated with a dark foundation slab
from frame 0 — so buildings rise out of a city that already has a street plan
rather than appearing in an empty void.

### The filler skyline is not your repository

Roughly 3000 background buildings fill the horizon on both banks. **None of them
mean anything.** Not one is a file, a commit or a line of code. They exist
because a real skyline does not stop at the edge of the interesting part, and a
data city floating alone on an empty plane reads as a diagram.

They are placed outside a moat around the data city, weighted heavily towards
short, and the haze eats most of them. The data city is the one picked out by
streetlights and traffic. If you are reading the horizon for meaning, don't —
read the lit part in the middle. They are a single `InstancedMesh`, so all 3000
cost one draw call.

Traffic is the same: headlights and tail lights running the streets carry no
data either. A still city reads as a model; a moving one reads as a place.

### Look and lighting

The scene is lit by a single sun vector, computed once at 2° elevation and 175°
azimuth and shared by the sky shader, the directional light and the water's
specular highlight. If those three disagree the image reads as wrong without it
being obvious why, so there is exactly one of them.

| | |
|---|---|
| sky | `Sky` — turbidity 8, rayleigh 2.5, mie 0.005 / 0.85 |
| sun | directional `#ffa06a` at 3, shadow camera fitted to the **data city** in light space, 2048² map |
| fill | hemisphere `#ffb088` over `#1a1428` at 0.6 |
| water | `Water`, 10000², `#0a1520`, distortion 2.5, normals committed to `assets/` |
| ground | two banks, roads in the district gaps, streetlights every 25 units, moving traffic |
| air | `FogExp2` in `#d8a8b8`, density solved per city — see below |
| output | ACES filmic, exposure 0.55, then `UnrealBloomPass` at 0.9 / 0.5 / 0.72 |

**Facades** are what stop the buildings reading as boxes, and the important
part is that the structure lives in the **colour** map, not just the emissive
one. A flat-coloured box with a few glowing dots on it is a box with glowing
dots on it, at any distance and in any light. What reads as a building is the
curtain wall itself: panes of dark glass held in a grid of mullions, floor slabs
and piers that catch the light whether or not anyone is home.

So each facade is generated once on a canvas and produces two maps off the same
grid — a colour map that is always visible, and an emissive map for the 28% of
panes that happen to be lit. Under half a facade lit reads as a wall of yellow
squares; a real tower at dusk is mostly dark glass with the lit offices
scattered through it, and that contrast is the depth.

There are three styles — `glass` (bright metal mullions, wide panes, high
metalness), `concrete` (stone piers, punched windows) and `brick` (warm masonry,
small openings) — picked per building from a hash of its path, so a file always
looks like itself and a skyline is not one building repeated. Buildings also
vary in how much of their 3×3 plot they fill, and anything over 12 units gets a
wider podium, because a building meets the ground differently from the way it
meets the sky.

The repeat on both maps is set from each segment's real width and height, so
window rows stay the same physical size on a two-storey file, on a
seventy-unit tower, and on each narrower tier of a setback. A shader patch caps
the roofs with flat dark membrane instead of the facade, and kills their
emission, without splitting every segment across two materials. The filler
carries a per-instance UV scale through the same trick, so 3000 background
buildings get correct facades from one draw call.

Bloom thresholds on **linear** radiance, before tone mapping, which is worth
knowing before picking emissive values: `#ffd9a0` has a linear luminance of
0.734, so anything below `emissiveIntensity` ≈ 0.98 never crosses the 0.72
threshold and never glows at all.

**Haze** is specified as a density, but the density that looks right depends on
how far back the camera is standing — and that is derived from the size of the
repository, not chosen. A fixed density puts a thin veil on a small city and an
opaque wall on a large one. So what is held constant here is the veil over the
*subject* (15%), and the density is solved for each city from
`1 - exp(-(density·d)²)`. At the minimum framing distance this works out to
0.0018; a sprawling repo framed from further back gets proportionally thinner
haze, and the horizon still washes out because it is still far away.

The fog colour is matched to what the sky actually renders at the horizon,
sampled from a frame rather than picked by eye. Fog darker than the horizon
makes distant geometry stand out against the sky instead of dissolving into it.

### The camera

The camera position is **never hardcoded**. After each layout:

1. Compute the bounding box of the whole city.
2. Model it as the cylinder enclosing its footprint — a cylinder radius does not
   depend on azimuth, so a fit that works at one angle works at every angle the
   auto-orbit passes through.
3. Bisect for the smallest distance at which every point on that cylinder still
   projects inside the frustum, with a 20% margin, checking **both** fields of
   view (on a portrait window the horizontal one binds).
4. Place the camera at 18° elevation, aimed 7° above the city centre, with
   `OrbitControls` damping on.

The 18° elevation is what makes it a skyline rather than a floor plan: low
enough that towers overlap and occlude each other. The 7° tilt is measured, not
chosen — it puts the horizon in the upper third of the frame, and since the near
edge of the city is what binds the fit, each degree of tilt costs distance.

The starting azimuth is not a free choice either. The sun sits at azimuth 175,
so a camera on the wrong side looks at the dull grey-green anti-solar horizon
with all the colour behind it. 135° keeps the sun just off the frame edge — glow
without a blown-out disc — and sets the river running corner to corner.

Framing is never closer than 220 units, so a barely-started city is viewed from
far enough back to look deliberate. As the city grows the framing is recomputed
and the camera eases outward — only ever back, never in, so a deliberate zoom is
not undone a frame later. While playing, the camera auto-orbits at 0.15 rad/sec,
which suspends while you are dragging.

### Performance

Shadows are the expensive part, and the sun never moves, so shadow maps are not
redrawn every frame: `shadowMap.autoUpdate` is off, and an update is requested
when a building is added or removed, and once more when the growth animation
settles so the resting heights cast the right shadows. The filler city casts no
shadows at all — it is scenery, and spending the shadow budget on 3000 buildings
nobody reads would be a poor trade. Pixel ratio is capped at 2.

The debug panel (`d`) reports FPS, draw calls, triangle count and filler count
alongside the city stats, which is the fastest way to tell a geometry problem
from a fill-rate one.

---

## The data schema

Every dataset — bundled or fetched live — is this shape:

```json
{
  "repo": "facebook/react",
  "generatedAt": "2026-08-19T18:41:02.511Z",
  "commits": [
    {
      "sha": "abc123",
      "date": "2026-08-19T18:41:02.511Z",
      "message": "first line only, truncated to 80 chars",
      "author": "name",
      "files": [
        { "path": "src/index.js", "status": "added", "lines": 340 }
      ]
    }
  ]
}
```

| field | meaning |
|---|---|
| `repo` | `owner/name`, shown in the HUD |
| `generatedAt` | ISO timestamp of generation |
| `commits` | **oldest first** — this is playback order |
| `commits[].sha` | short sha |
| `commits[].date` | ISO author date |
| `commits[].message` | first line only, truncated to 80 characters |
| `commits[].author` | author name |
| `commits[].files[].path` | repo-relative path; its folder becomes the district |
| `commits[].files[].status` | `added`, `modified`, or `removed` |
| `commits[].files[].lines` | **running total** line count of that file *after* this commit |

`lines` is the important one. It is not the number of lines changed — it is the
accumulated `additions - deletions` for that file across the history so far, so
a building's height is the size of the file at that point in time. It is never
negative and is floored at `1`, so a file that has been emptied still leaves a
stub rather than vanishing.

Datasets are listed in [`data/manifest.json`](data/manifest.json), so adding a
demo to the dropdown is a data change, not a code change:

```json
[{ "file": "data/axios-axios.json", "repo": "axios/axios", "label": "axios/axios — 300 commits" }]
```

---

## Generating data for your own repo

`scripts/fetch-history.cjs` needs Node 18+ and has no dependencies.

### From a clone (recommended)

```bash
node scripts/fetch-history.cjs --git https://github.com/axios/axios
node scripts/fetch-history.cjs --git ../my-local-checkout --out data/mine.json
```

This clones once and walks the **full** history with `git log --numstat`, so
running totals are exact all the way back to the repository's first commit, and
it costs no API budget at all. Merge commits are skipped (every content change
lives in exactly one non-merge commit, so nothing is double-counted) and rename
detection is off, so a rename reads as a demolition plus a new building.

### From the GitHub API

```bash
node scripts/fetch-history.cjs --repo axios/axios --token $GITHUB_TOKEN
```

Portable, but the changed-file list costs **one request per commit**: 300
commits is 300+ requests against a budget of 60/hour anonymously or 5000/hour
with a token. Totals also start from zero at the window's edge, because commits
older than the window are never fetched. Capped at 300 commits.

### Synthetic

```bash
node scripts/fetch-history.cjs --synthetic
```

Writes `sample/demo-repo` — 120 commits across 61 files in 6 folders, from a
seeded PRNG so it is reproducible. Useful when the API is unreachable and you
still want real input for the renderer.

Then add the file to `data/manifest.json` and it shows up in the dropdown.

---

## Verifying without rendering

```bash
$ node scripts/verify.cjs
```

`scripts/verify.cjs` imports **`js/layout.js` — the same module the browser
uses** — and replays a dataset in Node to print what the renderer will produce.
The verifier and the renderer cannot disagree about where a building goes or
where the camera ends up.

```
axios/axios   (data/axios-axios.json)
──────────────────────────────────────────────────────────────
  commits            300
  buildings (final)  334
  districts          59
  banks              bank 0: 37 districts, 227.0 x 79.0
                     bank 1: 22 districts, 161.0 x 62.0
  river channel      90 units wide

  building height    min 2.0   median 9.3   max 70.0
  largest district   docs/es/pages/advanced (25 files, 5x5)

  city bbox          227.0 wide x 70.0 tall x 231.0 deep
  camera position    -332.3, 187.7, 323.8
  camera distance    494.2  (fov 48, 18° elevation, 20% margin, aspect 1.78)

  scale check        footprint 231.0 units — OK
```

It exits non-zero if a city's footprint falls outside 20–5000 units, which is
the band where the scale is sane — smaller and the buildings are specks, larger
and the camera is so far out that everything aliases into mush.

Each dataset is checked in isolation, so one broken file does not stop the rest
being measured, and the run closes with how many of how many failed.

---

## Tests

```bash
npm test        # the unit suite
npm run check   # the suite, then every bundled dataset
```

Nothing to install first. The suite runs on Node's built-in test runner, so the
project keeps its no-build-step, no-install promise the whole way through —
`package.json` has no dependencies at all, dev ones included.

What is covered is the part with no visible failure mode. A wrong number in any
of it does not throw — it renders a city that is quietly the wrong shape, which
is the kind of bug nobody notices.

The project is split so that as much of that as possible can be run. Seven
modules import nothing but each other, and every one of them was at some point
a private function inside a file that needs a WebGL context:

| module | what it decides |
| --- | --- |
| `js/layout.js` | districts, plot positions, camera fit, haze, sun direction |
| `js/history.js` | which files will exist, which are landmarks, how tall the city gets |
| `js/variation.js` | each building's width, facade, shade, podium, tiers, heat |
| `js/stack.js` | how a height divides between a building's boxes, and the tween |
| `js/streets.js` | where the roads go, how far the horizon reaches, lamp spacing |
| `js/random.js` | the seeded generator all of the above draw from |
| `js/timeline.js` | playback state |

Also covered: the commit replay in `scripts/fetch-history.cjs`, the REST paging
and rate-limit handling in `js/github.js`, and `scripts/verify.cjs` driven as a
subprocess the way CI runs it.

The renderer itself is not unit-tested. Covering what is left of `js/city.js`,
`js/world.js` and `js/main.js` would mean a headless WebGL context and
screenshot diffs, a much larger commitment than this project warrants. Two
cheaper checks stand in: `tests/modules.test.mjs` parses all three with
`node --check` and resolves their imports, which catches the syntax and binding
mistakes that editing them actually produces; and `npm run verify` checks the
numbers they are handed.

CI runs both checks on every push and pull request, on Node 22 and 24.

---

## Running locally

`fetch()` cannot read `data/*.json` from a `file://` URL, so serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploying

It is a static site. Push to `main`, then **Settings → Pages → Source: Deploy
from a branch → `main` / `/ (root)`**. `.nojekyll` is committed so that Jekyll
does not interfere.

## Project layout

```
index.html                 markup + the three.js import map
css/style.css              all styling
js/main.js                 bootstrap, renderer, post-processing, camera, DOM wiring
js/city.js                 building meshes, materials, tweens, lifecycle
js/world.js                sun, sky, water, island, roads, streetlights, fog
js/textures.js             canvas-generated window and water-normal textures
js/github.js               dataset loading, live API, rate-limit handling
js/layout.js               pure — districts, positions, camera fit, haze, sun
js/history.js              pure — what the commit stream says before frame 0
js/variation.js            pure — how one building differs from its neighbour
js/stack.js                pure — the box stack, and the tween curve
js/streets.js              pure — the gaps the districts leave behind
js/random.js               pure — one seeded generator
js/timeline.js             pure — playback state machine
assets/waternormals.jpg    water normal map (three.js, MIT) — committed, not hotlinked
data/*.json                pre-generated commit data
data/manifest.json         which datasets appear in the dropdown
scripts/fetch-history.cjs   dataset generator
scripts/verify.cjs          headless geometry check
tests/*.test.mjs           unit suite, node:test, no dependencies
.github/workflows/ci.yml   runs both checks on push and pull request
```

The modules marked pure import nothing outside that group — no three.js, no
DOM — which is what lets the suite run them in Node. `js/city.js` re-exports
`js/layout.js`, so the geometry is a single import either way.

The division is not tidiness. Everything in those files was once a private
function inside the renderer, where a wrong constant could only be found by
opening a browser and looking at the city carefully enough to notice.

## Not in v1

Video export, language-specific parsing, file-content analysis, authentication
beyond the token field, and any framework or build step.

## License

MIT — see [LICENSE](LICENSE).
