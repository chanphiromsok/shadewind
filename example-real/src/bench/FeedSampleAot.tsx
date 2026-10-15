import { Pressable, Text, View } from 'react-native';
import { makePosts } from '../data/posts';
import { cn } from '../cn';
import { aot } from '../aotImpl';

const posts = makePosts(30);

// FeedSample with every literal-className View/Text resolved ahead of time (what a compiler would emit). Everything else is kept
// exactly as in FeedSample: the Pressables, the dynamic cn() className (Badge) and the inline-style overlap (Avatar) stay on the
// adapter, so the comparison with FeedSample is the adapter fibers of the literal views and nothing else.
const v = (c: string) => aot(c, 'view');
const t = (c: string) => aot(c, 'text');
const root = v('flex-1 bg-background');
const card = v('mx-3 mb-3 overflow-hidden rounded-2xl bg-card');
const head = v('flex-row items-center p-3');
const meta = v('ml-3 flex-1');
const author = t('text-base font-semibold text-primary');
const place = t('text-xs text-secondary');
const body = v('px-3 pb-2');
const title = t('text-lg font-bold text-primary');
const text = t('mt-1 text-sm leading-5 text-secondary');
const photos = v('flex-row px-3 pb-3');
const photoA = v('mr-2 h-28 flex-1 rounded-xl bg-brand-300');
const photoB = v('mr-2 h-28 flex-1 rounded-xl bg-blue-300');
const divider = v('h-px bg-divider');
const bar = v('flex-row');
const heart = t('text-base text-secondary');
const likes = t('ml-2 text-sm font-medium text-secondary');
const share = t('text-sm font-medium text-blue');
const sep = v('w-px bg-divider');
const avatarText = t('text-sm font-bold text-brand');
const badgeText = t('text-xs font-semibold text-brand');

const AvatarA = ({ label, hue }: { label: string; hue: number }) => (
  <View
    className={cn('items-center justify-center rounded-full bg-brand-300', 'h-10 w-10')}
    style={{ borderWidth: 2, borderColor: `hsl(${hue}, 60%, 55%)` }}
  >
    <avatarText.T {...avatarText.p()}>{label.slice(0, 1)}</avatarText.T>
  </View>
);

const BadgeA = ({ children }: { children: string }) => (
  <View className={cn('rounded-full px-2.5 py-1', 'bg-brand-300')}>
    <badgeText.T {...badgeText.p()}>{children}</badgeText.T>
  </View>
);

export function FeedSampleAot({ onLayout }: { onLayout: () => void }) {
  return (
    <root.T {...root.p()} onLayout={onLayout}>
      {posts.map((post) => (
        <card.T {...card.p()} key={post.id}>
          <head.T {...head.p()}>
            <AvatarA label={post.author} hue={post.hue} />
            <meta.T {...meta.p()}>
              <author.T {...author.p()}>{post.author}</author.T>
              <place.T {...place.p()}>
                {post.place} • {post.distance}
              </place.T>
            </meta.T>
            <BadgeA>{post.tag}</BadgeA>
          </head.T>
          <body.T {...body.p()}>
            <title.T {...title.p()}>{post.title}</title.T>
            <text.T {...text.p()}>{post.body}</text.T>
          </body.T>
          <photos.T {...photos.p()}>
            {Array.from({ length: post.photos }, (_, i) => {
              const photo = i % 2 === 0 ? photoA : photoB;

              return <photo.T {...photo.p()} key={i} />;
            })}
          </photos.T>
          <divider.T {...divider.p()} />
          <bar.T {...bar.p()}>
            <Pressable className="flex-1 flex-row items-center justify-center py-3 active:bg-card-pressed">
              <heart.T {...heart.p()}>♥</heart.T>
              <likes.T {...likes.p()}>{post.likes}</likes.T>
            </Pressable>
            <sep.T {...sep.p()} />
            <Pressable className="flex-1 flex-row items-center justify-center py-3 active:bg-card-pressed">
              <share.T {...share.p()}>Share</share.T>
            </Pressable>
          </bar.T>
        </card.T>
      ))}
    </root.T>
  );
}
