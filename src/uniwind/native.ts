// Direct use of the host components for the common, simple case. React Native's own View and Text do a lot of per-render work
// (accessibility prop mapping, style flattening, a pressability branch, a context read); for a view that has none of the props
// that work is about, it is a no-op, and skipping their fibers is what makes a styled view cheaper than plain Uniwind's.
// Anything outside the allowlist goes through the regular components, so behaviour is the same.
import type { ComponentType } from 'react';

const { default: NativeView } =
  require('react-native/Libraries/Components/View/ViewNativeComponent') as {
    default: ComponentType<any>;
  };
const { NativeText } =
  require('react-native/Libraries/Text/TextNativeComponent') as {
    NativeText: ComponentType<any>;
  };
const TextAncestorContext = (
  require('react-native/Libraries/Text/TextAncestorContext') as {
    default: React.Context<boolean>;
  }
).default;

export { NativeView, NativeText, TextAncestorContext };

// props React Native's View.js (0.86) rewrites or reads in JS
const VIEW_TRANSFORMED = [
  'accessibilityState',
  'accessibilityValue',
  'aria-busy',
  'aria-checked',
  'aria-disabled',
  'aria-expanded',
  'aria-hidden',
  'aria-label',
  'aria-labelledby',
  'aria-live',
  'aria-selected',
  'aria-valuemax',
  'aria-valuemin',
  'aria-valuenow',
  'aria-valuetext',
  'id',
  'tabIndex',
] as const;

export const viewIsPlain = (props: Record<string, unknown>): boolean => {
  for (let i = 0; i < VIEW_TRANSFORMED.length; i++) {
    if (props[VIEW_TRANSFORMED[i]!] !== undefined) {
      return false;
    }
  }

  return true;
};

// the only props a plain Text may carry for the direct path (everything else: Text.js has work to do)
const TEXT_PLAIN = new Set([
  'className',
  'children',
  'style',
  'numberOfLines',
  'testID',
  'ellipsizeMode',
  'ref',
]);

const primitive = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number';

const childrenArePrimitive = (children: unknown): boolean => {
  if (children == null || primitive(children)) {
    return true;
  }

  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (child != null && !primitive(child)) {
        return false;
      }
    }

    return true;
  }

  return false;
};

export const styleIsPlain = (style: unknown): boolean => {
  if (style == null) {
    return true;
  }

  if (typeof style !== 'object' || Array.isArray(style)) {
    return false;
  }

  const s = style as Record<string, unknown>;

  // Text.js rewrites these, and a line clamp sets numberOfLines in the Uniwind adapter
  return (
    typeof s.fontWeight !== 'number' &&
    s.userSelect == null &&
    s.verticalAlign == null &&
    s.WebkitLineClamp == null
  );
};

export const textIsPlain = (
  props: Record<string, unknown>,
  resolved: unknown
): boolean => {
  for (const key in props) {
    if (!TEXT_PLAIN.has(key)) {
      return false;
    }
  }

  return (
    childrenArePrimitive(props.children) &&
    styleIsPlain(resolved) &&
    styleIsPlain(props.style)
  );
};
