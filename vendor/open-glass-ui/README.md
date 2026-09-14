# OpenGlass UI, vendored

Source: https://github.com/moekoelueker/open-glass-ui (MIT, (c) 2026 Moe Luker).
The full licence sits beside this file.

## Why vendored rather than installed

The library's own guidance is to `import { Glass } from "open-glass-ui"` and
`import "open-glass-ui/styles.css"`. That needs React and a bundler. This
extension has neither, and Manifest V3 forbids remote code, so nothing can be
pulled from a CDN at runtime either. Adopting the facade as written would mean
adding React, a build step, and a bundled artifact to a project whose whole
shape is plain files loaded directly by Chrome.

What is used instead is the part that does not need any of that:

- `styles.css` is the library's recipe stylesheet, copied verbatim. The forty
  recipes are plain CSS on semantic DOM, so `.ogui-button`,
  `.ogui-segments`, `.ogui-toast` and the rest work exactly as shipped.
- `material.css` is **generated** from the library's own renderer, not written
  by hand. `packages/renderers/src/css.ts` exports `createCssMaterialTokens`,
  which returns the material as CSS custom properties; the React `<Glass>`
  component sets them inline. The generator runs that function and writes the
  same properties into a stylesheet keyed on the same `data-ogui-*` attributes
  `<Glass>` stamps. The values are therefore the library's, not an
  approximation of them.

The library's default renderer is CSS-first (`renderer="auto"`), which is
exactly this path. What is **not** available without the JS runtime is the
explicit SVG/SDF refraction and the opt-in WebGL2 surface; those need the
React components and a bundler.

## Regenerating

```
git clone --depth 1 https://github.com/moekoelueker/open-glass-ui
cp open-glass-ui/packages/recipes/src/styles.css vendor/open-glass-ui/styles.css
cp open-glass-ui/LICENSE vendor/open-glass-ui/LICENSE
# then run the emitter described in the header of material.css against
# open-glass-ui/packages/renderers/src/css.ts
```

`tests/side-panel.test.cjs` asserts the emitted values still match the
library's published numbers, so a regeneration that drifts fails.
