import './global.css';
import { useEffect, useState } from 'react';
import { Settings, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Explore from './src/screens/Explore';
import Simple from './src/screens/Simple';
import Account from './src/screens/Account';
import { runStall, type StallResult } from './src/bench/stall';

const Tab = createBottomTabNavigator();
const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;

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
      <NavigationContainer>
        <Tab.Navigator screenOptions={{ headerShown: false, lazy: false }}>
          <Tab.Screen name="Explore" component={Explore} options={{ tabBarIcon: icon('◎') }} />
          <Tab.Screen name="Moment" options={{ tabBarIcon: icon('▶') }}>
            {() => <Simple title="Moment" kind="moment" />}
          </Tab.Screen>
          <Tab.Screen name="Range" options={{ tabBarIcon: icon('⌖') }}>
            {() => <Simple title="Range" kind="range" />}
          </Tab.Screen>
          <Tab.Screen name="Notification" options={{ tabBarIcon: icon('◔') }}>
            {() => <Simple title="Notification" kind="notification" />}
          </Tab.Screen>
          <Tab.Screen name="Account" component={Account} options={{ tabBarIcon: icon('●') }} />
        </Tab.Navigator>
      </NavigationContainer>
      <AutoBench />
    </SafeAreaProvider>
  );
}
