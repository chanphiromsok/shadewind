import { Pressable, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';

export default function Gallery() {
  const nav = useNavigation();

  return (
    <View className="flex-1 items-center justify-center bg-black">
      <View className="h-72 w-72 rounded-3xl bg-brand-300" />
      <Pressable onPress={() => nav.goBack()} className="absolute right-4 top-14 rounded-full bg-white/20 px-4 py-2 active:opacity-70">
        <Text className="text-base font-semibold text-white">Close</Text>
      </Pressable>
    </View>
  );
}
