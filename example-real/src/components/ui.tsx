import { type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { cn } from '../cn';

// className-only building blocks, written the way tovtam writes them (cn + literals, active: states, theme tokens).

export const Avatar = ({ label, hue, size = 'h-10 w-10' }: { label: string; hue: number; size?: string }) => (
  <View
    className={cn('items-center justify-center rounded-full bg-brand-300', size)}
    style={{ borderWidth: 2, borderColor: `hsl(${hue}, 60%, 55%)` }}
  >
    <Text className="text-sm font-bold text-brand">{label.slice(0, 1)}</Text>
  </View>
);

export const Badge = ({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'blue' | 'orange' }) => (
  <View
    className={cn(
      'rounded-full px-2.5 py-1',
      tone === 'brand' && 'bg-brand-300',
      tone === 'blue' && 'bg-blue-300',
      tone === 'orange' && 'bg-orange-300'
    )}
  >
    <Text
      className={cn(
        'text-xs font-semibold',
        tone === 'brand' && 'text-brand',
        tone === 'blue' && 'text-blue',
        tone === 'orange' && 'text-orange'
      )}
    >
      {children}
    </Text>
  </View>
);

export const Chip = ({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) => (
  <Pressable
    onPress={onPress}
    className={cn(
      'mr-2 rounded-full border px-4 py-2 active:opacity-70',
      selected ? 'border-brand bg-brand' : 'border-divider bg-card'
    )}
  >
    <Text className={cn('text-sm font-semibold', selected ? 'text-white' : 'text-primary')}>{label}</Text>
  </Pressable>
);

export const Divider = () => <View className="h-px bg-divider" />;

export const Row = ({ title, value, onPress }: { title: string; value?: string; onPress?: () => void }) => (
  <Pressable onPress={onPress} className="flex-row items-center justify-between bg-card px-4 py-4 active:bg-card-pressed">
    <Text className="text-base text-primary">{title}</Text>
    <View className="flex-row items-center">
      {value ? <Text className="mr-2 text-sm text-secondary">{value}</Text> : null}
      <Text className="text-lg text-inactive">›</Text>
    </View>
  </Pressable>
);
