import type { ComponentType } from 'react';
import { View as RNView, type ViewProps } from 'react-native';
import { copyComponentProperties } from 'uniwind-internal/components/utils';
import { use } from 'react';
import {
  NativeView,
  TextAncestorContext,
  viewIsPlain,
  withUserStyle,
} from './native';
import { useEngineRef, useShadewindStyle } from './useShadewindStyle';
import { jsx } from 'react/jsx-runtime';

// read once at module load: Metro's inline requires would look each of these up on every render (see useShadewindStyle.ts), the
// JSX runtime included, so the render below calls `jsx` itself
const M = {
  useShadewindStyle,
  useEngineRef,
  use,
  TextAncestorContext,
  viewIsPlain,
  withUserStyle,
  NativeView,
  RNView,
  jsx,
};

type Props = ViewProps & { className?: string };

// annotated: the inferred type would expose React Native's private generated types in the shipped .d.ts
export const View: ComponentType<Props> = copyComponentProperties(
  RNView,
  (props: Props) => {
    const styled = M.useShadewindStyle(props.className, props);
    const { style } = styled;
    const ref = M.useEngineRef(styled, (props as { ref?: any }).ref);

    // inside a Text, or with props View.js rewrites: React Native's own View. Otherwise the host component directly.
    return M.jsx(
      !M.use(M.TextAncestorContext) && M.viewIsPlain(props)
        ? M.NativeView
        : M.RNView,
      { ...props, ref, style: M.withUserStyle(style, props.style) }
    );
  }
);

export default View;
