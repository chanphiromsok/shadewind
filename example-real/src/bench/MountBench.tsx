// Mount cost of the 2003-view TheirBench screen three ways, each timed from setState to the root's onLayout (-mountBench 1):
//   sheet  StyleSheet + React Native's own View / Text (deep imports: Uniwind's resolver does not rewrite them): the baseline
//   class  className through the Uniwind adapter (the engine arm: shadewind; the plain arm: Uniwind)
//   host   host components + StyleSheet (lower bound)
// The first mount of each variant is reported apart (cold: nothing cached yet), the rest as a mean. Order rotates per cycle.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ScrollView, Settings, StyleSheet, Text, View } from 'react-native';
import { FeedSample } from './FeedSample';
import { FeedSampleStatic } from './FeedSampleStatic';
import { ShadewindEngine } from 'shadewind/internal';

const RNView = require('react-native/Libraries/Components/View/View').default as React.ComponentType<any>;
const RNText = require('react-native/Libraries/Text/Text').default as React.ComponentType<any>;
const NView = require('react-native/Libraries/Components/View/ViewNativeComponent').default as React.ComponentType<any>;
const NText = require('react-native/Libraries/Text/TextNativeComponent').NativeText as React.ComponentType<any>;

type Kind = 'sheet' | 'class' | 'host';
const KINDS: Kind[] = ['sheet', 'class', 'host'];
const N = 1000;

const s = StyleSheet.create({
  list: { gap: 8, flexDirection: 'row', flexWrap: 'wrap' },
  item: { height: 100, width: '32%', alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#04ab52' },
  text: { fontSize: 24, lineHeight: 32, fontWeight: '700', color: '#222' },
});

const items = Array.from({ length: N }, (_, i) => i);

const marks = { layoutEffect: 0 };
const nowMs = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();

const feedMode = Settings.get('mountBench') === 'feed';

function Layered({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    marks.layoutEffect = nowMs();
  }, []);

  return <>{children}</>;
}

function FeedTree({ kind, onLayout }: { kind: Kind; onLayout: () => void }) {
  return (
    <Layered>
      {kind === 'class' ? <FeedSample onLayout={onLayout} /> : <FeedSampleStatic onLayout={onLayout} rn={kind === 'sheet'} />}
    </Layered>
  );
}

function Tree({ kind, onLayout }: { kind: Kind; onLayout: () => void }) {
  if (feedMode) {
    return <FeedTree kind={kind} onLayout={onLayout} />;
  }

  // after every child ref attached (the engine's registrations are queued by then, flushed in a microtask)
  useLayoutEffect(() => {
    marks.layoutEffect = nowMs();
  }, []);

  if (kind === 'class') {
    return (
      <ScrollView onLayout={onLayout} contentContainerStyle={{ gap: 8, flexDirection: 'row', flexWrap: 'wrap' }}>
        {items.map((i) => (
          <View key={i} className="h-25 w-[32%] items-center justify-center rounded-2xl bg-bench-primary">
            <Text className="text-2xl font-bold text-bench-typo">{i}</Text>
          </View>
        ))}
      </ScrollView>
    );
  }

  const V = kind === 'sheet' ? RNView : NView;
  const T = kind === 'sheet' ? RNText : NText;

  return (
    <ScrollView onLayout={onLayout} contentContainerStyle={s.list}>
      {items.map((i) => (
        <V key={i} style={s.item}>
          <T style={s.text}>{i}</T>
        </V>
      ))}
    </ScrollView>
  );
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] ?? 0;
const RUNS = Number(Settings.get('mountRuns')) || 36;
type Sample = { idle: number; total: number; render: number; layout: number; busy: number };

export function MountBench() {
  const [mounted, setMounted] = useState<{ kind: Kind; key: number } | null>(null);
  const [report, setReport] = useState('waiting');
  const waiter = useRef<(() => void) | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const samples: Record<Kind, Sample[]> = { sheet: [], class: [], host: [] };
      let busy = true;

      try {
        ShadewindEngine.resetMainBusy();
      } catch {
        busy = false;
      }

      for (let i = 0; i < RUNS * KINDS.length; i++) {
        const kind = KINDS[(i + Math.floor(i / KINDS.length)) % KINDS.length]!;

        await new Promise<void>((r) => setTimeout(r, 1000));
        if (busy) ShadewindEngine.resetMainBusy();
        const t0 = nowMs();

        // the benchmark's metric (docs/BENCHMARK.md): from the re-mount until the JS thread is idle; the idle callback is
        // requested after setState, like TheirBench, so it cannot run before the render
        let idleAt = 0;
        let idleDone: Promise<void> = Promise.resolve();

        await new Promise<void>((resolve) => {
          waiter.current = resolve;
          setMounted({ kind, key: i });
          // @ts-ignore requestIdleCallback exists on Hermes + React Native
          idleDone = new Promise<void>((r) => requestIdleCallback(() => { idleAt = nowMs(); r(); }));
        });
        const t1 = nowMs();

        await idleDone;

        // let the main thread finish mounting before reading its busy period
        await new Promise<void>((r) => setTimeout(r, 400));
        samples[kind].push({ idle: idleAt - t0, total: t1 - t0, render: marks.layoutEffect - t0, layout: t1 - marks.layoutEffect, busy: busy ? ShadewindEngine.mainBusyMs() : -1 });
        setMounted(null);
      }

      const line = (k: Kind) => {
        const w = samples[k];
        const f = (pick: (s: Sample) => number) => `${pct(w.map(pick), 0.5).toFixed(1)} (p25 ${pct(w.map(pick), 0.25).toFixed(1)})`;

        return `${k}: JS-idle med ${f((s) => s.idle)} | total med ${f((s) => s.total)} | render ${f((s) => s.render)} | layout ${f((s) => s.layout)} | mainBusy ${f((s) => s.busy)} | cold ${samples[k][0]!.total.toFixed(0)}`;
      };

      setReport(KINDS.map(line).join('\n'));
    }, 3000);

    return () => clearTimeout(t);
  }, []);

  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <Text testID="mount-report" style={{ fontSize: 10, padding: 8 }}>{`MOUNT ${feedMode ? '30 feed cards' : '2003 views'} engineOff=${String(Settings.get('engineOff') ?? 0)} resolverOff=${String(Settings.get('resolverOff') ?? 0)}\n${report}`}</Text>
      {mounted ? <Tree key={mounted.key} kind={mounted.kind} onLayout={() => waiter.current?.()} /> : null}
    </View>
  );
}
