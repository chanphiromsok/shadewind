import { ScrollView, Text, View } from 'react-native';
import { Row } from '../components/ui';

export default function SettingsDetail() {
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-3">
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
  );
}
