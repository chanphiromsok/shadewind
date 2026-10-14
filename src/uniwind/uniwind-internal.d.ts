// Uniwind's private modules, reached through the virtual `uniwind-internal/*` specifier that `shadewind/metro` resolves to the
// files Uniwind itself loads. Only what the adapter uses is typed, loosely: Uniwind owns these types.
declare module 'uniwind-internal/core/native' {
  export const UniwindStore: {
    vars: Record<string, unknown>;
    runtime: { currentThemeName: string };
    getStyles: (
      className: string | undefined,
      props: Record<string, any>,
      state: any,
      context: any
    ) => {
      styles: Record<string, unknown>;
      dependencies: number[];
      hasDataAttributes?: boolean;
    };
  };
}

declare module 'uniwind-internal/core/listener' {
  export const UniwindListener: {
    subscribe: (listener: () => void, dependencies: number[]) => () => void;
  };
}

declare module 'uniwind-internal/core/context' {
  export const useUniwindContext: () => { scopedTheme: string | null };
}

declare module 'uniwind-internal/common/consts' {
  export const StyleDependency: { Theme: number };
}

declare module 'uniwind-internal/components/utils' {
  export const copyComponentProperties: <T extends object>(
    component: T,
    wrapped: any
  ) => T;
}

declare module 'uniwind-internal/components/native/useAccentColor' {
  export const useAccentColor: (
    className: string | undefined,
    props: Record<string, any>,
    state?: any
  ) => string | undefined;
}
