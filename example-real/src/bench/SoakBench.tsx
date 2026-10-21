// `-soak 1`: mounts and unmounts a 1000-item list over and over, for a memory comparison of builds (scripts/memory-soak.sh samples the process
// footprint). Per item: literal classNames (View + Text), every 10th item an expression className that changes with the cycle, and a wrapper
// that forwards `{...props}` (the shape of an app's VStack). `-soakUnique N` adds N views per cycle with a className no earlier cycle used, the
// worst case for a per-className cache. `-soakCycles N` stops after N cycles (default 400).
import { useEffect, useState } from 'react';
import { ScrollView, Settings, Text, View, type ViewProps } from 'react-native';

const ITEMS = 1000;
const CYCLES = Number(Settings.get('soakCycles')) || 400;
const UNIQUE = Number(Settings.get('soakUnique')) || 0;
const THEMED = ['size-10 rounded-lg bg-brand', 'size-10 rounded-lg bg-card', 'size-10 rounded-lg bg-red-500'];

function Box({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={`items-center justify-center ${className ?? ''}`} {...props} />;
}

export function SoakBench() {
  const [cycle, setCycle] = useState(0);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    if (cycle >= CYCLES) {
      return undefined;
    }

    const timer = setTimeout(
      () => {
        if (shown) {
          setShown(false);
        } else {
          setShown(true);
          setCycle((c) => c + 1);
        }
      },
      shown ? 250 : 100
    );

    return () => clearTimeout(timer);
  }, [cycle, shown]);

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: 60 }}>
      <Text testID="soak-report" style={{ fontSize: 12, textAlign: 'center' }}>{`soak cycle ${cycle} of ${CYCLES}${cycle >= CYCLES ? ' DONE' : ''}`}</Text>
      {shown ? (
        <ScrollView contentContainerClassName="flex-row flex-wrap gap-1">
          {Array.from({ length: ITEMS }, (_, i) => (
            <View key={i} className="size-10 items-center justify-center rounded-lg bg-card">
              <Text className="text-xs font-bold text-primary">{i}</Text>
            </View>
          ))}
          {Array.from({ length: 100 }, (_, i) => (
            <View key={`e${i}`} className={THEMED[(cycle + i) % 3]} />
          ))}
          {Array.from({ length: 100 }, (_, i) => (
            <Box key={`s${i}`} className="size-10 bg-brand" testID={`soak-${i}`} />
          ))}
          {Array.from({ length: UNIQUE }, (_, i) => (
            <View key={`u${i}`} className={`size-10 w-[${cycle * UNIQUE + i + 1}px] bg-card`} />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
