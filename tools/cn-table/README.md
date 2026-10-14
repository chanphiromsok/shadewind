# cn table (tailwind-merge oracle)

Generates the conflict table that `cpp/css/ClassMerge.hpp` loads, and the differential test data.

```sh
node build_table.mjs   # needs corpus.json (cases = arrays of class strings), expected.json (twMerge(clsx(case)) outputs)
node js_bench.mjs      # clsx+twMerge vs cnfast on the same corpus, with a byte-equality check
```

`tailwind-merge` is the oracle: tokens are bucketed into conflict groups by asking it (mutual override = same group), and the
asymmetric overrides between groups are read from it too. A token that is not in the table makes the native merge return
`undefined`, so the caller falls back to the JS reference instead of guessing.
