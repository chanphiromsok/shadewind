import './global.css';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Settings, Text, View } from 'react-native';
import { ShadewindEngine } from 'shadewind/internal';
import { renders } from './src/engineReport';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { startup } from './src/bench/startup';
import { FeedSample } from './src/bench/FeedSample';
import { FeedSampleStatic } from './src/bench/FeedSampleStatic';
import { FeedSampleAot } from './src/bench/FeedSampleAot';
import { FeedSampleNoPress } from './src/bench/FeedSampleNoPress';
import { runIdle, runStall, type IdleResult, type StallResult } from './src/bench/stall';

type Kind = 'class' | 'static' | 'aot' | 'nopress';
const KINDS: Kind[] = ['class', 'aot', 'nopress', 'static'];

// `-realBench 1` runs the switch benchmark by itself 15 s after launch and shows the result on top of the app.
function AutoBench() {
  const [result, setResult] = useState<{ stall: StallResult; idle: IdleResult; mountMs: number; staticMs: number; aotMs: number; noPressMs: number } | null>(null);
  const [variant, setVariant] = useState<Kind>('class');
  const [mountKey, setMountKey] = useState<number | null>(null);
  const waiter = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!Settings.get('realBench')) {
      return undefined;
    }

    const t = setTimeout(async () => {
      // initial render: mount 30 cards, 10 times; each time from setState to the root's onLayout
      const perf = (globalThis as unknown as { performance: { now(): number } }).performance;
      const times: Record<Kind, number[]> = { class: [], static: [], aot: [], nopress: [] };

      // the variants alternate inside one launch, so launch-to-launch noise cancels
      // each cycle rotates the order, so every variant takes every slot equally often (the first mount of each is dropped)
      for (let i = 0; i < 48; i++) {
        const kind = KINDS[((i % KINDS.length) + Math.floor(i / KINDS.length)) % KINDS.length]!;

        await new Promise<void>((r) => setTimeout(() => r(), 150));
        setVariant(kind);
        const t0 = perf.now();

        await new Promise<void>((resolve) => {
          waiter.current = resolve;
          setMountKey(i);
        });
        times[kind].push(perf.now() - t0);
        setMountKey(null);
      }

      const mean = (a: number[]) => +(a.slice(1).reduce((x, y) => x + y, 0) / (a.length - 1)).toFixed(1);
      const mountMs = mean(times.class);
      const staticMs = mean(times.static);
      const aotMs = mean(times.aot);
      const noPressMs = mean(times.nopress);
      const idleResult = await runIdle();
      const stall = await runStall();

      setResult({ stall, idle: idleResult, mountMs, staticMs, aotMs, noPressMs });
    }, 15000);

    return () => clearTimeout(t);
  }, []);

  const sample =
    mountKey !== null ? (
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, overflow: 'hidden' }}>
        {variant === 'class' ? (
          <FeedSample key={mountKey} onLayout={() => waiter.current?.()} />
        ) : variant === 'aot' ? (
          <FeedSampleAot key={mountKey} onLayout={() => waiter.current?.()} />
        ) : variant === 'nopress' ? (
          <FeedSampleNoPress key={mountKey} onLayout={() => waiter.current?.()} />
        ) : (
          <FeedSampleStatic key={mountKey} onLayout={() => waiter.current?.()} />
        )}
      </View>
    ) : null;

  return result ? (
    <View pointerEvents="none" className="absolute left-3 right-3 top-12 rounded-xl bg-primary p-3">
      <Text testID="auto-stall" className="text-xs text-inverse">
        IDLE median {result.idle.medianMs} ms (sync {result.idle.syncMs}, micro {result.idle.microMs}), worst {result.idle.worstMs} | STALL median{' '}
        {result.stall.medianMs} ms, worst {result.stall.worstMs} | first feed layout {String(startup.firstLayoutMs)} ms | MOUNT
        30 cards className {result.mountMs} ms, aot {result.aotMs} ms, no Pressable {result.noPressMs} ms, static host {result.staticMs} ms
      </Text>
    </View>
  ) : (
    sample
  );
}

// Always mounted, plain style (no className, so the engine never registers it): shows what the engine thinks of the tree.
function Probe() {
  const [text, setText] = useState('probe');

  return (
    <View style={{ position: 'absolute', right: 4, top: 52, width: 150, backgroundColor: '#ffff00', padding: 2 }}>
      <Pressable
        testID="probe"
        onPress={() => {
          const r = ShadewindEngine.inspect();
          const total = [...renders.values()].reduce((a, b) => a + b, 0);

          setText(
            `theme=${r.theme} reg=${r.registered} inTree=${r.inTree} notInTree=${r.notInTree} hidden=${r.hidden} treeOK=${r.treeMatchesExpected} viewOK=${r.nativePropsMatchExpected} renders=${total} STALE ${String(r.stale ?? '').slice(0, 500)}`
          );
        }}
      >
        <Text testID="probe-text" style={{ fontSize: 8, color: '#000' }}>
          {text}
        </Text>
      </Pressable>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <RootNavigator />
      <AutoBench />
      <Probe />
    </SafeAreaProvider>
  );
}
