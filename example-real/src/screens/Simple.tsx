import { FlatList, Text, View } from 'react-native';
import { Avatar, Badge, Divider } from '../components/ui';

// Moment / Range / Notification: list screens built from the same blocks.
export default function Simple({ title, kind }: { title: string; kind: 'moment' | 'range' | 'notification' }) {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i), n: i }));

  return (
    <View className="flex-1 bg-background">
      <View className="bg-card px-4 pb-3 pt-14">
        <Text className="text-2xl font-bold text-primary">{title}</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        ItemSeparatorComponent={Divider}
        renderItem={({ item }) => (
          <View className="flex-row items-center bg-card px-4 py-3">
            <Avatar label={kind} hue={(item.n * 37) % 360} />
            <View className="ml-3 flex-1">
              <Text className="text-base font-semibold text-primary">
                {kind === 'range' ? `Place ${item.n}` : kind === 'moment' ? `Moment ${item.n}` : `Notification ${item.n}`}
              </Text>
              <Text className="text-xs text-secondary">{item.n % 3 === 0 ? 'Just now' : `${item.n} min ago`}</Text>
            </View>
            {item.n % 4 === 0 ? <Badge tone="orange">New</Badge> : null}
          </View>
        )}
      />
    </View>
  );
}
