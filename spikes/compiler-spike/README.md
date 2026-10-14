# Compiler spike (spike 6)

Proves the build chain on a real app's `global.css` and sources, no runtime and no app changes:

```sh
node compile.mjs <app-root>                          # oxide Scanner -> @tailwindcss/node compile().build(candidates); writes out.css next to it
node extract.mjs <app-root> <path/to/out.css> light,dark   # AST-based extractor: per-theme + base token maps, system-twin check, ARGB
```

`extract.mjs` is the **reviewed** extractor (selector classification on the Lightning CSS AST, layer-aware cascade key, clamped
ARGB with real alpha, system-twin equality check). The first version (regex over selector JSON) was wrong: see docs/ARCHITECTURE.md
section 11.

Needs `@tailwindcss/node`, `@tailwindcss/oxide`, `lightningcss`, `culori` resolvable from `<app-root>`.
