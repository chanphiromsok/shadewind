import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { PostCard } from '../components/PostCard';
import { Chip } from '../components/ui';
import { makePosts } from '../data/posts';
import { markFirstLayout } from '../bench/startup';

const CATEGORIES = ['All', 'Visit', 'Eat', 'Stay', 'Play'] as const;

export default function Explore({ count = 120 }: { count?: number }) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('All');
  const all = useMemo(() => makePosts(count), [count]);
  const data = useMemo(() => (category === 'All' ? all : all.filter((p) => p.tag === category)), [all, category]);

  return (
    <View className="flex-1 bg-background">
      <View className="bg-card px-3 pb-3 pt-14">
        <View className="flex-row items-center rounded-full bg-background px-4 py-3">
          <Text className="mr-2 text-secondary">⌕</Text>
          <Text className="flex-1 text-sm text-secondary">Search Destination</Text>
          <Text className="text-lg text-secondary">☰</Text>
        </View>
      </View>

      <FlatList
        testID="feed"
        onContentSizeChange={markFirstLayout}
        data={data}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => <PostCard post={item} />}
        initialNumToRender={8}
        windowSize={9}
        ListHeaderComponent={
          <View>
            <View className="m-3 flex-row items-center rounded-2xl bg-brand-300 p-4">
              <Text className="flex-1 text-sm text-primary">Become TovTam Partner and join us in creating memories</Text>
              <Pressable className="rounded-full bg-brand px-4 py-2 active:opacity-70">
                <Text className="text-sm font-bold text-white">Join</Text>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="px-3 pb-3">
              {CATEGORIES.map((c) => (
                <Chip key={c} label={c} selected={c === category} onPress={() => setCategory(c)} />
              ))}
            </ScrollView>
          </View>
        }
      />

      <Pressable className="absolute bottom-6 right-4 h-14 w-14 items-center justify-center rounded-full bg-brand active:opacity-80">
        <Text className="text-2xl text-white">+</Text>
      </Pressable>
    </View>
  );
}
