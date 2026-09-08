# Tests

`node --test tests/` — no dependencies, no build step, nothing to install.

The site itself has none either, and adding a test runner to a project whose
whole pitch is "open index.html and it works" would be a poor trade. Node has
shipped a test runner since 18, and `js/layout.js` and `js/github.js` are plain
ES modules, so they import here exactly as the browser loads them.

Scope is the pure layer: geometry, parsing and validation. The rendering in
`js/world.js` and `js/city.js` needs a GPU and is checked by `scripts/verify.cjs`,
which replays a dataset through the real layout module and reports the numbers
the renderer would produce.
