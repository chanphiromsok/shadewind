import './global.css';
import { useEffect, useState } from 'react';
import { Settings, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { startup } from './src/bench/startup';
import { runIdle, runStall, type IdleResult, type StallResult } from './src/bench/stall';

// `-realBench 1` runs the switch benchmark by itself 15 s after launch and shows the result on top of the app.
function AutoBench() {
  const [result, setResult] = useState<{ stall: StallResult; idle: IdleResult } | null>(null);

  useEffect(() => {
    if (!Settings.get('realBench')) {
      return undefined;
    }

    const t = setTimeout(async () => {
      const idleResult = await runIdle();
      const stall = await runStall();

      setResult({ stall, idle: idleResult });
    }, 15000);

    return () => clearTimeout(t);
  }, []);

  return result ? (
    <View pointerEvents="none" className="absolute left-3 right-3 top-12 rounded-xl bg-primary p-3">
      <Text testID="auto-stall" className="text-xs text-inverse">
        IDLE median {result.idle.medianMs} ms (sync {result.idle.syncMs}, micro {result.idle.microMs}), worst {result.idle.worstMs} | STALL median{' '}
        {result.stall.medianMs} ms, worst {result.stall.worstMs} | first feed layout {String(startup.firstLayoutMs)} ms
      </Text>
    </View>
  ) : null;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <RootNavigator />
      <AutoBench />
    </SafeAreaProvider>
  );
}
