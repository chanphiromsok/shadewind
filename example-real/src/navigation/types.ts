import type { NavigatorScreenParams } from '@react-navigation/native';

export type TabParamList = {
  Explore: undefined;
  Moment: undefined;
  Range: undefined;
  Notification: undefined;
  Account: undefined;
};

// Same shape as tovtam: a root stack that holds the tabs, pushed detail screens, a modal and a sheet.
export type RootStackParamList = {
  Main: NavigatorScreenParams<TabParamList>;
  PostDetail: { id: string };
  Profile: { author: string; hue: number };
  Gallery: { id: string };
  Settings: { section: string };
  ThemeSheet: undefined;
};
