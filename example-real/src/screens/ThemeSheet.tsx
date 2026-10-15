import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Uniwind, useUniwind } from 'uniwind';
import { cn } from '../cn';

// A form sheet like tovtam's Theme sheet: switching here changes the theme while Explore sits mounted behind it.
export default function ThemeSheet() {
  const { theme } = useUniwind();
  const nav = useNavigation();

  return (
    <View className="flex-1 bg-card p-4">
      <View className="flex-row items-center justify-between pb-4">
        <Text className="text-lg font-bold text-primary">Theme</Text>
        <Pressable onPress={() => nav.goBack()} className="active:opacity-70">
          <Text className="text-base text-brand">Done</Text>
        </Pressable>
      </View>
      <View className="flex-row overflow-hidden rounded-2xl bg-background">
        {(['light', 'dark'] as const).map((name) => (
          <Pressable
            key={name}
            testID={`sheet-${name}`}
            onPress={() => Uniwind.setTheme(name)}
            className={cn('flex-1 items-center py-4 active:opacity-70', theme === name && 'bg-brand-300')}
          >
            <Text className={cn('text-base font-semibold', theme === name ? 'text-brand' : 'text-primary')}>
              {name === 'light' ? '☀️  Light' : '🌙  Dark'}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
