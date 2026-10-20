// The render scenario of uni-stack/uniwind-benchmarks, as that app runs it (packages/benchmark/src/useBenchmark.ts): a header card and
// 1000 items; each of 10 runs bumps a key on the same ScrollView (React deletes the old 2003 views and mounts new ones) and is timed
// from just before that state change until requestIdleCallback; 100 ms between runs. The variant of the launch:
//   -mountKind sheet   StyleSheet + React Native's View / Text (their `stylesheet` app)
//   -mountKind class   className (Uniwind adapter; the engine arm: shadewind)
//   -mountKind host    host components + StyleSheet (lower bound)
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ScrollView, Settings, StyleSheet, Text, View } from 'react-native';

const RNView = require('react-native/Libraries/Components/View/View').default as React.ComponentType<any>;
const RNText = require('react-native/Libraries/Text/Text').default as React.ComponentType<any>;
const NView = require('react-native/Libraries/Components/View/ViewNativeComponent').default as React.ComponentType<any>;
const NText = require('react-native/Libraries/Text/TextNativeComponent').NativeText as React.ComponentType<any>;

const kind = String(Settings.get('mountKind') || 'class') as 'sheet' | 'class' | 'host';
const RUNS = 10;
const ITEMS = 1000;

const s = StyleSheet.create({
  scroll: { gap: 8, flexDirection: 'row', flexWrap: 'wrap' },
  item: { width: '32%', height: 100, borderRadius: 16, backgroundColor: '#00a8ff', alignItems: 'center', justifyContent: 'center' },
  text: { color: '#000', fontSize: 16, fontWeight: 'bold' },
});

const now = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();

export function RenderBench() {
  const [measurements, setMeasurements] = useState<number[]>([]);
  const [currentRun, setCurrentRun] = useState(0);
  const [renderKey, setRenderKey] = useState(0);

  const runBenchmark = useCallback(() => {
    const start = now();

    setRenderKey((p) => p + 1);
    // @ts-ignore requestIdleCallback exists on Hermes + React Native
    requestIdleCallback(() => {
      const duration = now() - start;

      setMeasurements((p) => [...p, duration]);
      setCurrentRun((p) => p + 1);
    });
  }, []);

  useLayoutEffect(() => {
    if (currentRun < RUNS) {
      const timer = setTimeout(runBenchmark, 100);

      return () => clearTimeout(timer);
    }

    return undefined;
  }, [currentRun, runBenchmark]);

  const done = currentRun >= RUNS;
  const sorted = [...measurements].sort((a, b) => a - b);
  const avg = measurements.reduce((a, b) => a + b, 0) / (measurements.length || 1);
  const V = kind === 'sheet' ? RNView : NView;
  const T = kind === 'sheet' ? RNText : NText;

  useEffect(() => {
    if (done) {
      Settings.set({ renderBenchResult: `${kind} avg ${avg.toFixed(2)} runs ${measurements.map((m) => m.toFixed(1)).join(',')}` });
    }
  }, [done, avg]);

  return (
    <View style={{ flex: 1, marginTop: 100, paddingHorizontal: 12 }}>
      <Text testID="render-report" style={{ fontSize: 14, textAlign: 'center', marginBottom: 16 }}>
        {done ? `RENDER ${kind} avg ${avg.toFixed(2)} ms | median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)} | min ${sorted[0]!.toFixed(2)} | max ${sorted[sorted.length - 1]!.toFixed(2)}` : `RENDER ${kind} run ${currentRun + 1}`}
      </Text>
      <ScrollView key={renderKey} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {Array.from({ length: ITEMS }, (_, i) =>
          kind === 'class' ? (
            <View key={i} className="h-25 w-[32%] items-center justify-center rounded-2xl bg-bench-primary">
              <Text className="text-2xl font-bold text-bench-typo">{i}</Text>
            </View>
          ) : (
            <V key={i} style={s.item}>
              <T style={s.text}>{i}</T>
            </V>
          )
        )}
      </ScrollView>
    </View>
  );
}
