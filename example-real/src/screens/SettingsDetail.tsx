import { Pressable, ScrollView, Text, View } from 'react-native';
import { Uniwind } from 'uniwind';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { Header, Row } from '../components/ui';
import type { RootStackParamList } from '../navigation/types';

export default function SettingsDetail() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'Settings'>>();
  const nav = useNavigation();

  return (
    <View className="flex-1 bg-background">
      <Header title={params.section} onBack={() => nav.goBack()} />
      <View className="flex-row gap-2 px-3 pt-2">
        <Pressable testID="settings-light" onPress={() => Uniwind.setTheme('light')} className="flex-1 items-center rounded-xl bg-card py-2">
          <Text className="text-sm text-primary">Light</Text>
        </Pressable>
        <Pressable testID="settings-dark" onPress={() => Uniwind.setTheme('dark')} className="flex-1 items-center rounded-xl bg-card py-2">
          <Text className="text-sm text-primary">Dark</Text>
        </Pressable>
      </View>
    <ScrollView className="flex-1" contentContainerClassName="p-3">
      <View className="overflow-hidden rounded-2xl">
        {Array.from({ length: 8 }, (_, i) => (
          <View key={i}>
            <Row title={`Option ${i + 1}`} value={i % 2 ? 'On' : 'Off'} />
            <View className="h-px bg-divider" />
          </View>
        ))}
      </View>
      <Text className="mt-4 px-2 text-xs text-secondary">Settings are local to this demo.</Text>
    </ScrollView>
    </View>
  );
}
