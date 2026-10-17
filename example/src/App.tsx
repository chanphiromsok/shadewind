import { useEffect, useRef, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ShadewindEngine } from 'shadewind/internal';
import {
  ThemedView,
  configure,
  followSystem,
  getTheme,
  setTheme,
  useTheme,
  useThemed,
  type ThemedStyles,
} from 'shadewind';
import BenchScreen from './BenchScreen';
import TheirBench from './TheirBench';
import CnBench from './CnBench';
import { Linking, Platform, Settings as RNSettings } from 'react-native';

type Routes = { Home: undefined; Settings: undefined; Bench: undefined };

const Stack = createNativeStackNavigator<Routes>();

configure({ themes: ['light', 'dark'], initialTheme: 'light' });

// Every screen is registered per theme once. Nothing here re-renders on a theme change.
const SCREEN: ThemedStyles = {
  light: { backgroundColor: '#eeeeee' },
  dark: { backgroundColor: '#000000' },
};

const CARD: ThemedStyles = {
  light: { backgroundColor: '#ffffff', borderColor: '#e5e5e5' },
  dark: { backgroundColor: '#1c1c1e', borderColor: '#3a3a3c' },
};

function Card({ label, pad = 16 }: { label: string; pad?: number }) {
  const themed = useThemed(CARD);

  return (
    <View
      ref={themed.ref}
      style={[styles.card, themed.style, { padding: pad }]}
    >
      <Text>{label}</Text>
    </View>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <ThemedView themed={SCREEN} style={styles.screen}>
      {children}
    </ThemedView>
  );
}

function Home({ navigation }: NativeStackScreenProps<Routes, 'Home'>) {
  const renders = useRef(0);
  const [debug, setDebug] = useState('inspect: not run');
  const [pad, setPad] = useState(16);

  renders.current++;

  return (
    <Screen>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <Text
          testID="home-renders"
          style={styles.info}
        >{`Home renders: ${renders.current} (frozen while Settings is on top)`}</Text>
        <Pressable
          testID="home-settings"
          style={styles.button}
          onPress={() => navigation.navigate('Settings')}
        >
          <Text style={styles.buttonText}>Go to Settings</Text>
        </Pressable>
        <Pressable
          testID="home-inspect"
          style={styles.button}
          onPress={() => {
            const r = ShadewindEngine.inspect();

            setDebug(
              `theme=${r.theme} registered=${r.registered} inTree=${r.inTree} notInTree=${r.notInTree} hidden=${r.hidden} treeOK=${r.treeMatchesExpected} viewOK=${r.nativePropsMatchExpected} layerOK=${r.layerMatchesExpected} ${r.samples ?? ''}`
            );
          }}
        >
          <Text style={styles.buttonText}>Inspect</Text>
        </Pressable>
        <Text testID="home-debug" style={styles.info}>
          {debug}
        </Text>
        <Pressable
          testID="home-bench"
          style={styles.button}
          onPress={() => navigation.navigate('Bench')}
        >
          <Text style={styles.buttonText}>Benchmark screen</Text>
        </Pressable>
        <Pressable
          testID="home-pad"
          style={styles.button}
          onPress={() => setPad((v) => (v === 16 ? 40 : 16))}
        >
          <Text style={styles.buttonText}>{`Padding ${pad}`}</Text>
        </Pressable>
        {Array.from({ length: 30 }, (_, i) => (
          <Card key={i} label={`Home card ${i}`} pad={pad} />
        ))}
      </ScrollView>
    </Screen>
  );
}

function Settings() {
  const theme = useTheme();

  return (
    <Screen>
      <Card label={`Settings card, theme ${theme}`} />
      <Pressable
        testID="settings-dark"
        style={styles.button}
        onPress={() => setTheme('dark')}
      >
        <Text style={styles.buttonText}>Dark</Text>
      </Pressable>
      <Pressable
        testID="settings-light"
        style={styles.button}
        onPress={() => setTheme('light')}
      >
        <Text style={styles.buttonText}>Light</Text>
      </Pressable>
      <Pressable
        testID="settings-toggle"
        style={styles.button}
        onPress={() => setTheme(getTheme() === 'light' ? 'dark' : 'light')}
      >
        <Text style={styles.buttonText}>Toggle</Text>
      </Pressable>
      <Pressable
        testID="settings-rapid"
        style={styles.button}
        onPress={() => {
          for (let i = 0; i < 7; i++) {
            setTheme(i % 2 === 0 ? 'dark' : 'light');
          }
        }}
      >
        <Text style={styles.buttonText}>Rapid x7 (ends on dark)</Text>
      </Pressable>
      <Pressable
        testID="settings-system"
        style={styles.button}
        onPress={() => followSystem()}
      >
        <Text style={styles.buttonText}>Follow system</Text>
      </Pressable>
    </Screen>
  );
}

type LaunchFlags = { bench: boolean; auto: boolean; strategy: string };

// Port of the uniwind-benchmarks theme scenario, shown at the root (no navigation stack).
// iOS: launch arguments `-theirBench 1` (manual) / `-benchmarkScenario theme [-strategy hook]` (starts by itself).
// Android: a VIEW intent `uwbench://theme?strategy=hook` (auto) or `uwbench://bench` (manual), like their harness.
function useLaunchFlags(): LaunchFlags | null {
  const [flags, setFlags] = useState<LaunchFlags | null>(() => {
    if (Platform.OS !== 'ios') {
      return null;
    }

    const auto = RNSettings.get('benchmarkScenario') === 'theme';

    return {
      bench: Boolean(RNSettings.get('theirBench')) || auto,
      auto,
      strategy: String(RNSettings.get('strategy') ?? 'hook'),
    };
  });

  useEffect(() => {
    if (Platform.OS === 'ios') {
      return;
    }

    Linking.getInitialURL()
      .then((url) => {
        const match = url?.match(
          /^uwbench:\/\/(theme|bench)(?:\?strategy=(\w+))?/
        );

        setFlags({
          bench: Boolean(match),
          auto: match?.[1] === 'theme',
          strategy: match?.[2] ?? 'hook',
        });
      })
      .catch(() => setFlags({ bench: false, auto: false, strategy: 'hook' }));
  }, []);

  return flags;
}

export default function App() {
  const flags = useLaunchFlags();

  if (RNSettings.get('cnBench')) {
    return <CnBench />;
  }

  if (flags === null) {
    return null; // Android: waiting for the initial URL
  }

  if (flags.bench) {
    return <TheirBench auto={flags.auto} strategy={flags.strategy} />;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ freezeOnBlur: true }}>
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Settings" component={Settings} />
        <Stack.Screen name="Bench" component={BenchScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  info: { margin: 12, fontSize: 12 },
  button: {
    margin: 12,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#04ab52',
  },
  buttonText: { color: 'white', fontWeight: '600' },
  card: {
    margin: 6,
    marginHorizontal: 12,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
});
