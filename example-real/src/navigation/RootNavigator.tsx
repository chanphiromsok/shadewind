import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Explore from '../screens/Explore';
import Simple from '../screens/Simple';
import Account from '../screens/Account';
import PostDetail from '../screens/PostDetail';
import Profile from '../screens/Profile';
import Gallery from '../screens/Gallery';
import SettingsDetail from '../screens/SettingsDetail';
import ThemeSheet from '../screens/ThemeSheet';
import TabBar from './TabBar';
import type { RootStackParamList, TabParamList } from './types';

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const Moment = () => <Simple title="Moment" kind="moment" />;
const Range = () => <Simple title="Range" kind="range" />;
const Notification = () => <Simple title="Notification" kind="notification" />;

function Tabs() {
  return (
    <Tab.Navigator tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false, lazy: false }}>
      <Tab.Screen name="Explore" component={Explore} />
      <Tab.Screen name="Moment" component={Moment} />
      <Tab.Screen name="Range" component={Range} />
      <Tab.Screen name="Notification" component={Notification} />
      <Tab.Screen name="Account" component={Account} />
    </Tab.Navigator>
  );
}

// The navigation theme is a stable object with transparent surfaces: every pixel of chrome and background belongs to a
// className view (bound to the engine), so a theme switch renders nothing in the navigator (rule 1 for navigation chrome).
const navTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: 'transparent', card: 'transparent', border: 'transparent' },
};

export default function RootNavigator() {
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}>
        <Stack.Screen name="Main" component={Tabs} />
        <Stack.Screen name="PostDetail" component={PostDetail} />
        <Stack.Screen name="Profile" component={Profile} />
        <Stack.Screen name="Gallery" component={Gallery} options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
        <Stack.Screen name="Settings" component={SettingsDetail} />
        <Stack.Screen name="ThemeSheet" component={ThemeSheet} options={{ presentation: 'formSheet', sheetAllowedDetents: [0.4] }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
