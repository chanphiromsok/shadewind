import { ScrollView, Text, View, Pressable } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { makePosts } from '../data/posts';
import { Avatar, Badge, Divider } from '../components/ui';
import type { RootStackParamList } from '../navigation/types';

const posts = makePosts(120);

export default function PostDetail() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'PostDetail'>>();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const post = posts.find((p) => p.id === params.id) ?? posts[0]!;

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="pb-10">
      <View className="bg-card p-4">
        <Pressable
          onPress={() => nav.navigate('Profile', { author: post.author, hue: post.hue })}
          className="flex-row items-center active:opacity-70"
        >
          <Avatar label={post.author} hue={post.hue} size="h-12 w-12" />
          <View className="ml-3 flex-1">
            <Text className="text-base font-semibold text-primary">{post.author}</Text>
            <Text className="text-xs text-secondary">
              {post.place} • {post.distance}
            </Text>
          </View>
          <Badge>{post.tag}</Badge>
        </Pressable>
        <Text className="mt-4 text-2xl font-bold text-primary">{post.title}</Text>
        <Text className="mt-2 text-base leading-6 text-secondary">{post.body}</Text>
      </View>
      <Pressable onPress={() => nav.navigate('Gallery', { id: post.id })} className="m-3 h-48 rounded-2xl bg-brand-300 active:opacity-80" />
      <Divider />
      {Array.from({ length: 12 }, (_, i) => (
        <View key={i} className="flex-row bg-card px-4 py-3">
          <Avatar label={`C${i}`} hue={(i * 53) % 360} size="h-8 w-8" />
          <View className="ml-3 flex-1">
            <Text className="text-sm font-semibold text-primary">Commenter {i}</Text>
            <Text className="text-sm text-secondary">Great spot, we went last weekend.</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}
