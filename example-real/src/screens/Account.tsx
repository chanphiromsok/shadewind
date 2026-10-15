import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Uniwind } from 'uniwind';
import { decisions, status } from '../engineReport';
import type { RootStackParamList } from '../navigation/types';
import { Row } from '../components/ui';
import { runStall, type StallResult } from '../bench/stall';
import { cn } from '../cn';

export default function Account() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [result, setResult] = useState<StallResult | 'running' | null>(null);
  const [report, setReport] = useState<string[] | null>(null);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="pb-10">
      <View className="bg-card px-4 pb-4 pt-14">
        <Text className="text-2xl font-bold text-primary">Account</Text>
      </View>

      <Text className="px-4 pb-2 pt-6 text-xs font-semibold uppercase text-secondary">Appearance</Text>
      <View className="mx-3 flex-row overflow-hidden rounded-2xl bg-card">
        {(['light', 'dark'] as const).map((name) => (
          <Pressable
            key={name}
            testID={`theme-${name}`}
            onPress={() => Uniwind.setTheme(name)}
            className={cn('flex-1 items-center py-4 active:opacity-70', name === 'light' ? 'light:bg-brand-300' : 'dark:bg-brand-300')}
          >
            <Text className={cn('text-base font-semibold', name === 'light' ? 'light:text-brand dark:text-primary' : 'dark:text-brand light:text-primary')}>
              {name === 'light' ? '☀️  Light' : '🌙  Dark'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text className="px-4 pb-2 pt-6 text-xs font-semibold uppercase text-secondary">Settings</Text>
      <View className="mx-3 overflow-hidden rounded-2xl">
        <Row onPress={() => nav.navigate('Settings', { section: 'Language' })} title="Language" value="English" />
        <View className="h-px bg-divider" />
        <Row onPress={() => nav.navigate('ThemeSheet')} title="Theme sheet" />
        <View className="h-px bg-divider" />
        <Row onPress={() => nav.navigate('Settings', { section: 'Notifications' })} title="Notifications" value="On" />
        <View className="h-px bg-divider" />
        <Row onPress={() => nav.navigate('Settings', { section: 'Privacy' })} title="Privacy" />
        <View className="h-px bg-divider" />
        <Row onPress={() => nav.navigate('Settings', { section: 'Help & Support' })} title="Help & Support" />
      </View>

      <Text className="px-4 pb-2 pt-6 text-xs font-semibold uppercase text-secondary">Benchmark</Text>
      <View className="mx-3 rounded-2xl bg-card p-4">
        <Pressable
          testID="run-stall"
          onPress={async () => {
            setResult('running');
            setResult(await runStall());
          }}
          className="items-center rounded-xl bg-brand py-3 active:opacity-80"
        >
          <Text className="text-base font-bold text-white">Run switch benchmark</Text>
        </Pressable>
        <Pressable
          testID="engine-report"
          onPress={() => {
            const counts = new Map<string, number>();

            decisions.forEach((reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1));
            setReport([`install: ${status()}`, ...[...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} x ${r}`)]);
          }}
          className="mt-3 items-center rounded-xl bg-card-pressed py-3 active:opacity-80"
        >
          <Text className="text-base font-semibold text-primary">Engine report</Text>
        </Pressable>
        {report ? (
          <Text testID="engine-report-text" className="mt-2 text-xs text-secondary">
            {report.join('\n')}
          </Text>
        ) : null}
        {result === 'running' ? <Text className="mt-3 text-sm text-secondary">running…</Text> : null}
        {result && result !== 'running' ? (
          <View className="mt-3">
            <Text testID="stall-result" className="text-sm text-primary">
              median stall {result.medianMs} ms, worst {result.worstMs} ms
            </Text>
            <Text className="mt-1 text-xs text-secondary">{result.stalls.join(', ')}</Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
