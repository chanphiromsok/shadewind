// `-edgeCases 1`: a grid of className edge cases that steps through theme switches and className changes on a timer, to compare builds
// pixel by pixel (scripts/edge-cases.py). Run it in the plain Uniwind arm (REAL_PLAIN=1, the oracle), the adapter and the build with
// SHADEWIND_PRECOMPILE=1: every cell must look the same in every phase.
//
// The grid re-renders only when `on` changes (phases 3 and 5); the other steps are theme switches alone.
// Phases (4 s each): 0 light | 1 dark | 2 light | 3 `on` | 4 dark (while `on`) | 5 not `on` (dark) | 6 light, with the grid re-rendered in the same tick. The header shows the phase as filled
// squares, so a screenshot can be matched to a phase without reading text.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ScopedTheme, Uniwind } from 'uniwind';
import { ShadewindEngine } from 'shadewind/internal';

const PHASES = 7;
const PHASE_MS = 4000;

let mounts = 0;

// The phase lives outside React state on purpose: a theme-only step must not re-render the grid, or every view would pick the new theme up
// by re-rendering and a view the engine does not repaint (or repaints wrongly) would look right.
let phaseNow = 0;
const phaseListeners = new Set<() => void>();
const setPhaseNow = (next: number) => {
  phaseNow = next;
  phaseListeners.forEach((listener) => listener());
};
const usePhase = () =>
  useSyncExternalStore(
    (listener) => {
      phaseListeners.add(listener);

      return () => {
        phaseListeners.delete(listener);
      };
    },
    () => phaseNow
  );

// what the engine thinks of the tree, one phase after each step (not part of the pixel comparison)
function Inspect() {
  const phase = usePhase();
  const [text, setText] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const r = ShadewindEngine.inspect?.();

        setText(r ? `phase ${phase} reg=${r.registered} inTree=${r.inTree} treeOK=${r.treeMatchesExpected} viewOK=${r.nativePropsMatchExpected} STALE ${String(r.stale ?? '').slice(0, 300)}` : 'no inspect');
      } catch {
        setText('inspect failed');
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [phase]);

  return <Text style={s.inspect}>{text}</Text>;
}

function Header() {
  const phase = usePhase();

  return (
    <View style={s.header}>
      {Array.from({ length: PHASES }, (_, i) => (
        <View key={i} style={[s.square, i <= phase && s.squareOn]} />
      ))}
    </View>
  );
}

// a className that is a different one in every phase, themed in each
function Rotating() {
  const phase = usePhase();
  const className = ['size-16 bg-brand', 'size-16 bg-card', 'size-16 bg-blue-300'][phase % 3]!;

  return <View className={className} />;
}

// shows how many times it was mounted (a count above 1 means its parent remounted it)
function MountCount() {
  const [n] = useState(() => ++mounts);

  return <Text style={s.tiny}>{n}</Text>;
}

function Cell({ children }: { children?: React.ReactNode }) {
  return <View style={s.cell}>{children}</View>;
}

export function EdgeCases() {
  const [on, setOn] = useState(false);
  const [, setTick] = useState(0);
  const order = on ? ['c', 'b', 'a'] : ['a', 'b', 'c'];
  const selected = on ? 'b' : 'a';

  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return undefined;
    }

    startedRef.current = true;
    Uniwind.setTheme('light');

    const steps = [
      () => Uniwind.setTheme('dark'),
      () => Uniwind.setTheme('light'),
      () => setOn(true),
      () => Uniwind.setTheme('dark'),
      () => setOn(false),
      () => {
        // a theme switch and a re-render of the whole grid in the same tick (a parent that re-renders while the theme changes)
        Uniwind.setTheme('light');
        setTick((t) => t + 1);
      },
    ];

    steps.forEach((step, i) => {
      setTimeout(() => {
        step();
        setPhaseNow(i + 1);
      }, PHASE_MS * (i + 1));
    });

    return undefined;
  }, []);

  return (
    <View className="flex-1 bg-background" style={s.root}>
      <Header />
      <View style={s.grid}>
        <Cell>
          <View className="size-16 rounded-lg border border-divider bg-card" />
        </Cell>
        <Cell>
          <View className="size-16 rounded-lg bg-brand" />
        </Cell>
        <Cell>
          <View className="size-16 rounded-lg bg-red-500" />
        </Cell>
        <Cell>
          <View className="size-16 items-center justify-center rounded-lg bg-card">
            <Text className="text-xl font-bold text-primary">Aa</Text>
          </View>
        </Cell>

        {/* what the engine cannot paint, or paints only in part */}
        <Cell>
          <View className="size-16 bg-card dark:opacity-40" />
        </Cell>
        <Cell>
          <View className="size-16 light:bg-orange dark:bg-blue" />
        </Cell>
        <Cell>
          <View className="size-16 dark:bg-black" />
        </Cell>
        <Cell>
          <View className="size-16 bg-card sm:bg-orange" />
        </Cell>

        {/* className as an expression that changes with `on` */}
        <Cell>
          <View className={on ? 'size-16 bg-brand' : 'size-16 bg-card'} />
        </Cell>
        <Cell>
          <View className={on ? 'size-16 bg-brand' : 'size-16 bg-red-500'} />
        </Cell>
        <Cell>
          <View style={s.fill}>
            <View className={on ? 'flex-1 bg-brand' : undefined} style={s.fillInner}>
              <MountCount />
            </View>
          </View>
        </Cell>
        <Cell>
          <View className={on ? 'size-16 bg-brand' : 'size-16 bg-card sm:bg-orange'}>
            <MountCount />
          </View>
        </Cell>

        {/* mount, hide, reveal, reorder */}
        <Cell>{on ? <View className="size-16 bg-brand" /> : null}</Cell>
        <Cell>
          <View style={{ display: on ? 'none' : 'flex' }}>
            <View className="size-16 bg-card" />
          </View>
        </Cell>
        <Cell>
          <View style={s.row}>
            {order.map((id) => (
              <View key={id} className={id === selected ? 'h-16 w-5 bg-brand' : 'h-16 w-5 bg-card'}>
                <MountCount />
              </View>
            ))}
          </View>
        </Cell>
        <Cell>
          <Rotating />
        </Cell>

        {/* text */}
        <Cell>
          <Text className="text-xl text-primary">
            A<Text className="text-brand">B</Text>
          </Text>
        </Cell>
        <Cell>
          <Text className="text-xl text-primary" onPress={() => {}}>
            P
          </Text>
        </Cell>
        <Cell>
          <Text numberOfLines={1} className="w-16 text-secondary">
            Long long text here
          </Text>
        </Cell>
        <Cell>
          <Text className={on ? 'text-xl text-brand' : undefined} style={s.tiny}>
            T
          </Text>
        </Cell>

        {/* left as written by the plugin */}
        <Cell>
          <View style={{ opacity: 0.9 }} className="size-16 bg-card" />
        </Cell>
        <Cell>
          <View {...{ testID: 'spread' }} className="size-16 bg-card" />
        </Cell>
        <Cell>
          <ScopedTheme theme="dark">
            <View className="size-16 bg-card" />
          </ScopedTheme>
        </Cell>
        <Cell>
          <Pressable className="size-16 bg-card active:bg-brand" />
        </Cell>

        {/* one className on several views */}
        <Cell>
          <View style={s.row}>
            <View className="size-5 bg-brand" />
            <View className="size-5 bg-brand" />
            <View className="size-5 bg-brand" />
          </View>
        </Cell>
        <Cell>
          <View className="size-16 items-center justify-center bg-brand">
            <View className="size-8 bg-card" />
          </View>
        </Cell>
        <Cell>
          <View className="size-16 border-4 border-brand bg-card" />
        </Cell>
        <Cell>
          <View className="size-16 rounded-full bg-orange-300" />
        </Cell>
      </View>
      <Inspect />
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingTop: 64, paddingHorizontal: 8 },
  header: { flexDirection: 'row', height: 14, marginBottom: 8 },
  square: { width: 12, height: 12, marginRight: 4, backgroundColor: '#ccc' },
  squareOn: { backgroundColor: '#000' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '25%', height: 84, alignItems: 'center', justifyContent: 'center' },
  fill: { width: 64, height: 64, backgroundColor: '#999' },
  fillInner: { flex: 1 },
  row: { flexDirection: 'row' },
  tiny: { fontSize: 9, color: '#f0f' },
  inspect: { fontSize: 9, color: '#888', marginTop: 8 },
});
