import { Pressable, Text, View } from 'react-native';
import { makePosts } from '../data/posts';
import { Avatar, Badge, Divider } from '../components/ui';
import { cn } from '../cn';

const posts = makePosts(30);

// The feed card without navigation or state: the same styled views as PostCard, mounted in bulk for the render benchmark.
export function FeedSample({ onLayout }: { onLayout: () => void }) {
  return (
    <View onLayout={onLayout} className="flex-1 bg-background">
      {posts.map((post) => (
        <View key={post.id} className="mx-3 mb-3 overflow-hidden rounded-2xl bg-card">
          <View className="flex-row items-center p-3">
            <Avatar label={post.author} hue={post.hue} />
            <View className="ml-3 flex-1">
              <Text className="text-base font-semibold text-primary">{post.author}</Text>
              <Text className="text-xs text-secondary">
                {post.place} • {post.distance}
              </Text>
            </View>
            <Badge>{post.tag}</Badge>
          </View>
          <View className="px-3 pb-2">
            <Text className="text-lg font-bold text-primary">{post.title}</Text>
            <Text className="mt-1 text-sm leading-5 text-secondary">{post.body}</Text>
          </View>
          <View className="flex-row px-3 pb-3">
            {Array.from({ length: post.photos }, (_, i) => (
              <View key={i} className={cn('mr-2 h-28 flex-1 rounded-xl', i % 2 === 0 ? 'bg-brand-300' : 'bg-blue-300')} />
            ))}
          </View>
          <Divider />
          <View className="flex-row">
            <Pressable className="flex-1 flex-row items-center justify-center py-3 active:bg-card-pressed">
              <Text className="text-base text-secondary">♥</Text>
              <Text className="ml-2 text-sm font-medium text-secondary">{post.likes}</Text>
            </Pressable>
            <View className="w-px bg-divider" />
            <Pressable className="flex-1 flex-row items-center justify-center py-3 active:bg-card-pressed">
              <Text className="text-sm font-medium text-blue">Share</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}
