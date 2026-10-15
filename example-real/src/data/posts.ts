// Deterministic mock feed (no network): the same data on every launch, so runs are comparable.
export type Post = {
  id: string;
  author: string;
  verified: boolean;
  place: string;
  distance: string;
  title: string;
  body: string;
  tag: 'Visit' | 'Eat' | 'Stay' | 'Play';
  likes: number;
  comments: number;
  hue: number;
  photos: number;
};

const places = ['Phnom Penh', 'Siem Reap', 'Kampot', 'Kep', 'Battambang', 'Sihanoukville'];
const tags = ['Visit', 'Eat', 'Stay', 'Play'] as const;
const titles = [
  'View from the riverside',
  'Best noodle soup in town',
  'A quiet villa near the market',
  'Sunset over the temple',
  'Weekend at the pepper farms',
  'Street food after dark',
];

export const makePosts = (count: number): Post[] => {
  // seeded per call: every caller gets the same feed, whatever imported first
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    author: i % 5 === 0 ? 'TovTam' : `Traveler ${i}`,
    verified: i % 5 === 0,
    place: places[i % places.length]!,
    distance: `${(rand() * 9 + 0.3).toFixed(2)} km away`,
    title: `${titles[i % titles.length]} ${i}`,
    body:
      'Borey Villa is a calm place to start the day. Fresh air, slow traffic and a short walk to the water. ' +
      'Come early, bring cash and take the side street.',
    tag: tags[i % tags.length]!,
    likes: Math.floor(rand() * 900),
    comments: Math.floor(rand() * 90),
    hue: Math.floor(rand() * 360),
    photos: 1 + (i % 3),
  }));
};
