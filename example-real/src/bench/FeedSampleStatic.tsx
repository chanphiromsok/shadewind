import type React from 'react';
import { StyleSheet } from 'react-native';

// the host components themselves: no Uniwind adapter and no RN wrapper fiber (deep imports are not rewritten by Uniwind's resolver)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NView = require('react-native/Libraries/Components/View/ViewNativeComponent').default as React.ComponentType<any>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NText = require('react-native/Libraries/Text/TextNativeComponent').NativeText as React.ComponentType<any>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RNView = require('react-native/Libraries/Components/View/View').default as React.ComponentType<any>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RNText = require('react-native/Libraries/Text/Text').default as React.ComponentType<any>;

import { makePosts } from '../data/posts';

const posts = makePosts(30);

// The same card as FeedSample with no className, no adapter and no hooks: host components and frozen styles. This is what an AOT
// transform of literal classNames could emit; it is the lower bound used to see how much the adapter fiber costs at mount.
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f5f5f5' },
  card: { marginHorizontal: 12, marginBottom: 12, overflow: 'hidden', borderRadius: 16, backgroundColor: '#fff' },
  head: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  avatar: { height: 40, width: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#e6f7ec', borderWidth: 2 },
  avatarText: { fontSize: 14, fontWeight: '700', color: '#04ab52' },
  meta: { marginLeft: 12, flex: 1 },
  author: { fontSize: 16, fontWeight: '600', color: '#222' },
  place: { fontSize: 12, color: '#777' },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#e6f7ec' },
  badgeText: { fontSize: 12, fontWeight: '600', color: '#04ab52' },
  body: { paddingHorizontal: 12, paddingBottom: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#222' },
  text: { marginTop: 4, fontSize: 14, lineHeight: 20, color: '#777' },
  photos: { flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 12 },
  photo: { marginRight: 8, height: 112, flex: 1, borderRadius: 12 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#eee' },
  bar: { flexDirection: 'row' },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  actionText: { marginLeft: 8, fontSize: 14, fontWeight: '500', color: '#777' },
  sep: { width: StyleSheet.hairlineWidth, backgroundColor: '#eee' },
});

export function FeedSampleStatic({ onLayout, rn = false }: { onLayout: () => void; rn?: boolean }) {
  // rn: React Native's own View / Text (the StyleSheet baseline of an ordinary app), else the host components
  const V = rn ? RNView : NView;
  const T = rn ? RNText : NText;

  return (
    <V onLayout={onLayout} style={s.root}>
      {posts.map((post) => (
        <V key={post.id} style={s.card}>
          <V style={s.head}>
            <V style={[s.avatar, { borderColor: `hsl(${post.hue}, 60%, 55%)` }]}>
              <T style={s.avatarText}>{post.author.slice(0, 1)}</T>
            </V>
            <V style={s.meta}>
              <T style={s.author}>{post.author}</T>
              <T style={s.place}>
                {post.place} • {post.distance}
              </T>
            </V>
            <V style={s.badge}>
              <T style={s.badgeText}>{post.tag}</T>
            </V>
          </V>
          <V style={s.body}>
            <T style={s.title}>{post.title}</T>
            <T style={s.text}>{post.body}</T>
          </V>
          <V style={s.photos}>
            {Array.from({ length: post.photos }, (_, i) => (
              <V key={i} style={[s.photo, { backgroundColor: i % 2 === 0 ? '#e6f7ec' : '#e0f2fb' }]} />
            ))}
          </V>
          <V style={s.divider} />
          <V style={s.bar}>
            <V style={s.action}>
              <T style={s.actionText}>♥</T>
              <T style={s.actionText}>{post.likes}</T>
            </V>
            <V style={s.sep} />
            <V style={s.action}>
              <T style={s.actionText}>Share</T>
            </V>
          </V>
        </V>
      ))}
    </V>
  );
}
