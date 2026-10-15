import './global.css';
import { useEffect, useState } from 'react';
import { Settings, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { runStall, type StallResult } from './src/bench/stall';

// `-realBench 1` runs the switch benchmark by itself 15 s after launch and shows the result on top of the app.
function AutoBench() {
  const [result, setResult] = useState<StallResult | null>(null);

  useEffect(() => {
    if (!Settings.get('realBench')) {
      return undefined;
    }

    const t = setTimeout(() => runStall().then(setResult), 15000);

    return () => clearTimeout(t);
  }, []);

  return result ? (
    <View pointerEvents="none" className="absolute left-3 right-3 top-12 rounded-xl bg-primary p-3">
      <Text testID="auto-stall" className="text-xs text-inverse">
        AUTO median stall {result.medianMs} ms, worst {result.worstMs} ms, [{result.stalls.join(',')}]
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
