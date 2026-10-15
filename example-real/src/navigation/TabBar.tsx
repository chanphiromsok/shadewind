import { Pressable, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { cn } from '../cn';

const GLYPH: Record<string, string> = { Explore: '◎', Moment: '▶', Range: '⌖', Notification: '◔', Account: '●' };

// A tab bar of className views. Which tab is focused is navigation state; the colours are theme tokens the engine owns.
export default function TabBar({ state, navigation }: BottomTabBarProps) {
  return (
    <View className="flex-row border-t border-divider bg-card pb-6 pt-2">
      {state.routes.map((route, index) => {
        const focused = state.index === index;

        return (
          <Pressable
            key={route.key}
            onPress={() => navigation.navigate(route.name)}
            className="flex-1 items-center py-1 active:opacity-60"
          >
            <Text className={cn('text-xl', focused ? 'text-brand' : 'text-inactive')}>{GLYPH[route.name]}</Text>
            <Text className={cn('text-xs font-medium', focused ? 'text-brand' : 'text-inactive')}>{route.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
