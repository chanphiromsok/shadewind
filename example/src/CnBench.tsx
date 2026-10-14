import { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { cn as cnfast } from 'cnfast';
import { ShadewindEngine } from 'shadewind/internal';
import { cn as shadewindCn, configureCn } from 'shadewind';
import { CASES, EXPECTED, TABLE } from './cnData';

// Differential test + timing of class merging on Hermes (release): clsx+twMerge (reference), cnfast, native C++ (JSI).
const reference = (parts: string[]) => twMerge(clsx(parts));

function time(label: string, fn: (parts: string[]) => unknown, passes = 3) {
  let best = Infinity;

  for (let p = 0; p < passes; p++) {
    const t0 = performance.now();

    for (let i = 0; i < CASES.length; i++) {
      fn(CASES[i]!);
    }

    best = Math.min(best, performance.now() - t0);
  }

  return `${label}: ${((best * 1e6) / CASES.length).toFixed(0)} ns/call`;
}

export default function CnBench() {
  const [lines, setLines] = useState<string[]>(['running...']);

  useEffect(() => {
    const t = setTimeout(() => {
      const out: string[] = [];
      const loaded = ShadewindEngine.loadClassTable(TABLE);

      out.push(`table loaded: ${loaded}`);

      let nativeMismatch = 0;
      let nativeFallback = 0;
      let fastMismatch = 0;

      for (let i = 0; i < CASES.length; i++) {
        const parts = CASES[i]!;
        const want = EXPECTED[i]!;
        const n = ShadewindEngine.mergeClasses(...parts);

        if (n === undefined) {
          nativeFallback++;
        } else if (n !== want) {
          nativeMismatch++;
        }

        if (cnfast(...parts) !== want) {
          fastMismatch++;
        }
      }

      out.push(
        `cases ${CASES.length} | native mismatches ${nativeMismatch} fallbacks ${nativeFallback} | cnfast mismatches ${fastMismatch}`
      );
      out.push(time('clsx+twMerge (JS)', reference));
      out.push(time('cnfast (JS)', (p) => cnfast(...p)));
      out.push(
        time('Nitro raw method, zero-copy', (p) =>
          ShadewindEngine.mergeClasses(...p)
        )
      );
      out.push(
        time('floor: Nitro method, 1 short string', (p) =>
          ShadewindEngine.mergeClasses(p[0]!)
        )
      );

      const g = globalThis as unknown as {
        __swCn: (...p: string[]) => string | undefined;
      };

      let globalMismatch = 0;

      for (let i = 0; i < CASES.length; i++) {
        const parts = CASES[i]!;

        if (g.__swCn(...parts) !== EXPECTED[i]) {
          globalMismatch++;
        }
      }

      out.push(`global host fns mismatches ${globalMismatch}`);
      out.push(time('global host fn __swCn', (p) => g.__swCn(...p)));
      out.push(
        time('floor: global fn, 1 short string', (p) => g.__swCn(p[0]!))
      );
      configureCn({ table: TABLE, fallback: (...a) => twMerge(clsx(a)) });

      let publicMismatch = 0;

      for (let i = 0; i < CASES.length; i++) {
        if (shadewindCn(...CASES[i]!) !== EXPECTED[i]) {
          publicMismatch++;
        }
      }

      out.push(`public cn() mismatches ${publicMismatch}`);
      out.push(time('public cn(...)', (p) => shadewindCn(...p)));
      setLines(out);
    }, 1500);

    return () => clearTimeout(t);
  }, []);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 60 }}>
      <Text testID="cn-title" style={{ fontWeight: '700', marginBottom: 8 }}>
        cn benchmark (Hermes)
      </Text>
      {lines.map((l, i) => (
        <Text key={i} testID={`cn-line-${i}`} style={{ marginBottom: 6 }}>
          {l}
        </Text>
      ))}
    </ScrollView>
  );
}
