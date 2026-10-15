import { Text, View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import { Avatar, Badge, Header } from '../components/ui';
import type { RootStackParamList } from '../navigation/types';

export default function Profile() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'Profile'>>();
  const nav = useNavigation();

  return (
    <View className="flex-1 bg-background">
      <Header title="Profile" onBack={() => nav.goBack()} />
      <View className="items-center bg-card pb-6 pt-8">
        <Avatar label={params.author} hue={params.hue} size="h-20 w-20" />
        <Text className="mt-3 text-xl font-bold text-primary">{params.author}</Text>
        <View className="mt-2 flex-row">
          <Badge>Local guide</Badge>
          <View className="w-2" />
          <Badge tone="blue">1M followers</Badge>
        </View>
      </View>
      <View className="m-3 rounded-2xl bg-card p-4">
        <Text className="text-sm text-secondary">Shares places worth a detour: cafes, riverside walks and hidden temples.</Text>
      </View>
    </View>
  );
}
