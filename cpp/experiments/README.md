# SIMD experiments

`FamilyIndex.hpp`: a flat pointer -> uint32 map that probes 16 slots per step (NEON on arm64, SSE2 on x86-64, portable loop
otherwise): the Swiss-table technique. 1 control byte per slot holds a 7-bit hash tag; one vector compare tests 16 tags; a bitmask
names the candidates; only those keys are read. Models the hook's per-node question "is this ShadowNodeFamily registered?".

`bench.cpp`: `clang++ -O2 -std=c++17 bench.cpp -o bench && ./bench` (Apple arm64, single run, malloc'd "families", shuffled order).

| scenario | std::unordered_map | FamilyIndex (NEON) | ratio |
|---|---|---|---|
| 2003 nodes, 2003 registered, hot | 18.3 ns/node | 6.7 ns | 2.7x |
| 2003 / 2003, cold | 12.5 | 4.9 | 2.6x |
| 6000 nodes, 108 registered, hot | 3.6 | 3.5 | 1.0x |
| 6000 / 108, cold | 8.0 | 9.5 | 0.85x (noise, 5 reps) |
| 50000 nodes, 500 registered, hot | 6.0 | 2.5 | 2.4x |
| 50000 / 500, cold | 9.6 | 2.4 | 4.0x |

Reading: faster when the registered set is large or the tree is large (cache-bound), no gain when the table is tiny. In absolute
terms a 6000-node walk costs about 20 us either way; this is not where a 60 ms real-app stall comes from. Not wired into
`ThemeHook` yet.
