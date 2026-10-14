import './global.css'
import { useState } from 'react'
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native'
import { ScopedTheme, Uniwind } from 'uniwind'
import { ShadewindEngine } from 'shadewind'
import { decisions, renders } from './node_modules/uniwind/src/shadewind/useShadewindStyle'

// Spike B test screen: every row has a known expected colour per theme (see EXPECTED below).
// Each row is a Uniwind View/Text going through the Shadewind adapter.

const EXPECTED = `
A bg-primary: light #00a8ff, dark #273c75, ocean #0b3d91
B bg-white dark:bg-black: light white, dark black
C bg-[light-dark(#fff,#000)]: light white, dark black
D dark:bg-black only: light none (page white), dark black
E text-black active:text-primary: black in light, pressed -> primary
F bg-primary + inline red: always red
G TouchableOpacity bg-primary: like A
H ScopedTheme(dark) bg-primary: always #273c75
I toggled class bg-primary / bg-gray: follows theme after toggle
J nested Text: outer typography (black/white), inner text-black stays black
`

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 4 }}>
    <Text style={{ width: 70, fontSize: 11 }}>{label}</Text>
    {children}
  </View>
)

export default function SpikeB() {
  const [flag, setFlag] = useState(true)
  const [, force] = useState(0)
  const [pad, setPad] = useState(0)

  return (
    <ScrollView className="bg-white dark:bg-black" contentContainerStyle={{ paddingTop: 60, paddingHorizontal: 12, paddingBottom: 80 }}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {(['light', 'dark', 'ocean'] as const).map((theme) => (
          <Pressable key={theme} testID={`set-${theme}`} onPress={() => Uniwind.setTheme(theme)} style={{ backgroundColor: '#555', padding: 8, borderRadius: 6 }}>
            <Text style={{ color: '#fff' }}>{theme}</Text>
          </Pressable>
        ))}
        <Pressable testID="toggle-class" onPress={() => setFlag((f) => !f)} style={{ backgroundColor: '#555', padding: 8, borderRadius: 6 }}>
          <Text style={{ color: '#fff' }}>toggle class</Text>
        </Pressable>
        <Pressable
          testID="update-vars"
          onPress={() => Uniwind.updateCSSVariables('dark', { '--color-primary': '#ff0000' } as any)}
          style={{ backgroundColor: '#555', padding: 8, borderRadius: 6 }}
        >
          <Text style={{ color: '#fff' }}>dark primary=red</Text>
        </Pressable>
        <Pressable testID="inspect" onPress={() => force((n) => n + 1)} style={{ backgroundColor: '#555', padding: 8, borderRadius: 6 }}>
          <Text style={{ color: '#fff' }}>refresh labels</Text>
        </Pressable>
        <Pressable testID="pad" onPress={() => setPad((p) => (p ? 0 : 20))} style={{ backgroundColor: '#555', padding: 8, borderRadius: 6 }}>
          <Text style={{ color: '#fff' }}>rerender</Text>
        </Pressable>
      </View>

      <Row label="A">
        <View testID="row-A" className="bg-primary" style={{ width: 80, height: 28, marginLeft: pad }} />
      </Row>
      <Row label="B">
        <View testID="row-B" className="bg-white dark:bg-black" style={{ width: 80, height: 28, borderWidth: 1, borderColor: '#888' }} />
      </Row>
      <Row label="C">
        <View testID="row-C" className="bg-[light-dark(#ffffff,#000000)]" style={{ width: 80, height: 28, borderWidth: 1, borderColor: '#888' }} />
      </Row>
      <Row label="D">
        <View testID="row-D" className="dark:bg-black" style={{ width: 80, height: 28, borderWidth: 1, borderColor: '#888' }} />
      </Row>
      <Row label="E">
        <View className="bg-gray" style={{ padding: 4 }}>
          <Text testID="row-E" className="text-black active:text-primary">press me</Text>
        </View>
      </Row>
      <Row label="F">
        <View testID="row-F" className="bg-primary" style={{ width: 80, height: 28, backgroundColor: '#ff0000' }} />
      </Row>
      <Row label="G">
        <TouchableOpacity testID="row-G" className="bg-primary" style={{ width: 80, height: 28 }} />
      </Row>
      <Row label="H">
        <ScopedTheme theme="dark">
          <View testID="row-H" className="bg-primary" style={{ width: 80, height: 28 }} />
        </ScopedTheme>
      </Row>
      <Row label="I">
        <View testID="row-I" className={flag ? 'bg-primary' : 'bg-gray'} style={{ width: 80, height: 28 }} />
      </Row>
      <Row label="J">
        <View className="bg-gray" style={{ padding: 4 }}>
          <Text testID="row-J" className="text-typography">
            outer <Text className="text-black">inner</Text>
          </Text>
        </View>
      </Row>

      <Text style={{ marginTop: 10, fontSize: 11 }}>{EXPECTED}</Text>
      <Text testID="decisions" style={{ marginTop: 10, fontSize: 11 }}>
        {[...decisions.entries()].map(([cn, reason]) => `${cn} => ${reason}`).join('\n')}
      </Text>
      <Text testID="renders" style={{ fontSize: 11 }}>
        {[...renders.entries()].filter(([k]) => k.startsWith('row-')).map(([k, n]) => k + ': ' + n + ' renders').join(', ')}
      </Text>
      <Text testID="engine-theme" style={{ fontSize: 11 }}>{`engine theme: ${ShadewindEngine.getTheme()}`}</Text>
    </ScrollView>
  )
}
