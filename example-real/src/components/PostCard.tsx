import { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Post } from '../data/posts';
import { cn } from '../cn';
import { Avatar, Badge, Divider } from './ui';

const tone = { Visit: 'brand', Eat: 'orange', Stay: 'blue', Play: 'brand' } as const;

// One feed card: header row, title, body, photo grid, reaction bar. Roughly 30 styled views, like tovtam's story card.
export const PostCard = memo(({ post }: { post: Post }) => {
  const [liked, setLiked] = useState(false);

  return (
    <View className="mx-3 mb-3 overflow-hidden rounded-2xl bg-card">
      <View className="flex-row items-center p-3">
        <Avatar label={post.author} hue={post.hue} />
        <View className="ml-3 flex-1">
          <View className="flex-row items-center">
            <Text className="text-base font-semibold text-primary">{post.author}</Text>
            {post.verified ? <Text className="ml-1 text-sm text-brand">✔</Text> : null}
          </View>
          <Text className="text-xs text-secondary">
            {post.place} • {post.distance}
          </Text>
        </View>
        <Badge tone={tone[post.tag]}>{post.tag}</Badge>
      </View>

      <View className="px-3 pb-2">
        <Text className="text-lg font-bold text-primary">{post.title}</Text>
        <Text className="mt-1 text-sm leading-5 text-secondary">{post.body}</Text>
      </View>

      <View className="flex-row px-3 pb-3">
        {Array.from({ length: post.photos }, (_, i) => (
          <View
            key={i}
            className={cn('mr-2 h-28 flex-1 rounded-xl', i % 2 === 0 ? 'bg-brand-300' : 'bg-blue-300')}
            style={{ opacity: 0.6 + i * 0.15 }}
          />
        ))}
      </View>

      <Divider />

      <View className="flex-row">
        <Pressable
          onPress={() => setLiked((v) => !v)}
          className="flex-1 flex-row items-center justify-center py-3 active:bg-card-pressed"
        >
          <Text className={cn('text-base', liked ? 'text-error' : 'text-secondary')}>♥</Text>
          <Text className={cn('ml-2 text-sm font-medium', liked ? 'text-error' : 'text-secondary')}>
            {post.likes + (liked ? 1 : 0)}
          </Text>
        </Pressable>
        <View className="w-px bg-divider" />
        <Pressable className="flex-1 flex-row items-center justify-center py-3 active:bg-card-pressed">
          <Text className="text-base text-secondary">💬</Text>
          <Text className="ml-2 text-sm font-medium text-secondary">{post.comments}</Text>
        </Pressable>
        <View className="w-px bg-divider" />
        <Pressable className="flex-1 items-center justify-center py-3 active:bg-card-pressed">
          <Text className="text-sm font-medium text-blue">Share</Text>
        </Pressable>
      </View>
    </View>
  );
});
