import './global.css';
import { useEffect, useRef, useState } from 'react';
import { Settings, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { startup } from './src/bench/startup';
import { FeedSample } from './src/bench/FeedSample';
import { runIdle, runStall, type IdleResult, type StallResult } from './src/bench/stall';

// `-realBench 1` runs the switch benchmark by itself 15 s after launch and shows the result on top of the app.
function AutoBench() {
  const [result, setResult] = useState<{ stall: StallResult; idle: IdleResult; mountMs: number } | null>(null);
  const [mountKey, setMountKey] = useState<number | null>(null);
  const waiter = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!Settings.get('realBench')) {
      return undefined;
    }

    const t = setTimeout(async () => {
      // initial render: mount 30 cards, 10 times; each time from setState to the root's onLayout
      const perf = (globalThis as unknown as { performance: { now(): number } }).performance;
      const times: number[] = [];

      for (let i = 0; i < 10; i++) {
        await new Promise<void>((r) => setTimeout(() => r(), 150));
        const t0 = perf.now();

        await new Promise<void>((resolve) => {
          waiter.current = resolve;
          setMountKey(i);
        });
        times.push(perf.now() - t0);
        setMountKey(null);
      }

      const mountMs = +(times.slice(1).reduce((a, b) => a + b, 0) / (times.length - 1)).toFixed(1);
      const idleResult = await runIdle();
      const stall = await runStall();

      setResult({ stall, idle: idleResult, mountMs });
    }, 15000);

    return () => clearTimeout(t);
  }, []);

  const sample =
    mountKey !== null ? (
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, overflow: 'hidden' }}>
        <FeedSample key={mountKey} onLayout={() => waiter.current?.()} />
      </View>
    ) : null;

  return result ? (
    <View pointerEvents="none" className="absolute left-3 right-3 top-12 rounded-xl bg-primary p-3">
      <Text testID="auto-stall" className="text-xs text-inverse">
        IDLE median {result.idle.medianMs} ms (sync {result.idle.syncMs}, micro {result.idle.microMs}), worst {result.idle.worstMs} | STALL median{' '}
        {result.stall.medianMs} ms, worst {result.stall.worstMs} | first feed layout {String(startup.firstLayoutMs)} ms | MOUNT
        30 cards avg {result.mountMs} ms
      </Text>
    </View>
  ) : (
    sample
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <RootNavigator />
      <AutoBench />
    </SafeAreaProvider>
  );
}
