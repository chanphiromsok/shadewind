# shadewind site

`index.template.html` is the page. Its benchmark numbers come from `benchmark.json`; `node tools/build-site.cjs` writes `dist/index.html` (not committed).

Update the benchmark: change the number in `docs/BENCHMARK.md` and `README.md` first, then in `benchmark.json`. The build fails when a number in the JSON is in neither document. Pushing to `main` redeploys.

Preview: `node tools/build-site.cjs && python3 -m http.server -d site/dist 8000`.
