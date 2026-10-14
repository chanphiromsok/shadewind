# Compiler spike (spike 6)

Proves the build chain on a real app's `global.css` and sources, no runtime and no app changes:

```sh
node compile.mjs <app-root>   # oxide Scanner -> @tailwindcss/node compile().build(candidates) -> lightningcss visitor, writes out.css
node extract.mjs <app-root>   # reads out.css: per-theme --color-* tokens via the lightningcss visitor, oklch -> ARGB via culori
```

Needs `@tailwindcss/node`, `@tailwindcss/oxide`, `lightningcss`, `culori` resolvable from `<app-root>`.
Result on tovtam (2026-10-14, M-series Mac, cold): see docs/ARCHITECTURE.md section 9.
