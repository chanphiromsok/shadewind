import { useMemo } from 'react';
import { Text } from 'react-native';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useCSSVariable, useUniwind } from 'uniwind';
import Explore from '../screens/Explore';
import Simple from '../screens/Simple';
import Account from '../screens/Account';
import PostDetail from '../screens/PostDetail';
import Profile from '../screens/Profile';
import Gallery from '../screens/Gallery';
import SettingsDetail from '../screens/SettingsDetail';
import ThemeSheet from '../screens/ThemeSheet';
import type { RootStackParamList, TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;

const Moment = () => <Simple title="Moment" kind="moment" />;
const Range = () => <Simple title="Range" kind="range" />;
const Notification = () => <Simple title="Notification" kind="notification" />;

function Tabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false, lazy: false }}>
      <Tab.Screen name="Explore" component={Explore} options={{ tabBarIcon: icon('◎') }} />
      <Tab.Screen name="Moment" component={Moment} options={{ tabBarIcon: icon('▶') }} />
      <Tab.Screen name="Range" component={Range} options={{ tabBarIcon: icon('⌖') }} />
      <Tab.Screen name="Notification" component={Notification} options={{ tabBarIcon: icon('◔') }} />
      <Tab.Screen name="Account" component={Account} options={{ tabBarIcon: icon('●') }} />
    </Tab.Navigator>
  );
}

// Like tovtam's useThemeConfig: the navigation theme is a JS object derived from the current theme. It is a React consumer
// of the theme (the container re-renders on a switch), which is part of what a real app pays.
export default function RootNavigator() {
  const { theme } = useUniwind();
  const [card, background, text] = useCSSVariable(['--color-card', '--color-background', '--color-primary']) as string[];
  const navTheme = useMemo(
    () => ({
      ...(theme === 'dark' ? DarkTheme : DefaultTheme),
      colors: {
        ...(theme === 'dark' ? DarkTheme : DefaultTheme).colors,
        card: card ?? '#fff',
        background: background ?? '#f5f5f5',
        text: text ?? '#111',
      },
    }),
    [theme, card, background, text]
  );

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator>
        <Stack.Screen name="Main" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="PostDetail" component={PostDetail} options={{ title: 'Post' }} />
        <Stack.Screen name="Profile" component={Profile} options={{ title: 'Profile' }} />
        <Stack.Screen
          name="Gallery"
          component={Gallery}
          options={{ presentation: 'fullScreenModal', headerShown: false, animation: 'fade' }}
        />
        <Stack.Screen name="Settings" component={SettingsDetail} options={({ route }) => ({ title: route.params.section })} />
        <Stack.Screen
          name="ThemeSheet"
          component={ThemeSheet}
          options={{ presentation: 'formSheet', headerShown: false, sheetAllowedDetents: [0.4] }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
