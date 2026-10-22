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

// The resolved className style, with the user's `style` after it only when there is one: a single object (Uniwind caches one per
// className) is cheaper for React Native than an array, which it flattens, and a new array per render never diffs as unchanged.
export const withUserStyle = (resolved: unknown, user: unknown): any =>
  user == null || user === false ? resolved : [resolved, user];

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

const VIEW_TRANSFORMED_SET = new Set<string>(VIEW_TRANSFORMED);

// walks the props the view was given (a few) instead of probing the 17 it could have been (a miss each)
export const viewIsPlain = (props: Record<string, unknown>): boolean => {
  for (const key in props) {
    if (VIEW_TRANSFORMED_SET.has(key) && props[key] !== undefined) {
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

// `numericWeight`: a numeric fontWeight is fine, the caller passes the style through `nativeTextStyle` (the resolved className
// style only; the user's `style` keeps the strict check, converting it would be a new object per render)
export const styleIsPlain = (
  style: unknown,
  numericWeight = false
): boolean => {
  if (style == null) {
    return true;
  }

  if (typeof style !== 'object' || Array.isArray(style)) {
    return false;
  }

  const s = style as Record<string, unknown>;

  // Text.js rewrites these, and a line clamp sets numberOfLines in the Uniwind adapter
  return (
    (numericWeight || typeof s.fontWeight !== 'number') &&
    s.userSelect == null &&
    s.verticalAlign == null &&
    s.WebkitLineClamp == null
  );
};

// What Text.js (0.86) does to the style before the host component, for the direct path:
// - a numeric fontWeight (Uniwind resolves `font-bold` to 700) becomes a string (`String(fontWeight)`); without this every `font-*`
//   Text took the full Text.js path (one more component, two closures per render)
// - with the `defaultTextToOverflowHidden` flag (on by default) its default style `overflow: 'hidden'` goes first, so a className
//   overflow still wins. Missing it left every direct Text with visible overflow (unlike Text.js), measured +17 MiB native memory
//   on the 2003-view screen
// One copy per resolved style object, so the style stays the same object across renders.
const textStyles = new WeakMap<object, object>();
let overflowHidden: boolean | undefined;
const TEXT_DEFAULT = { overflow: 'hidden' };

const defaultOverflowHidden = (): boolean => {
  if (overflowHidden === undefined) {
    try {
      overflowHidden = (
        require('react-native/src/private/featureflags/ReactNativeFeatureFlags') as {
          defaultTextToOverflowHidden: () => boolean;
        }
      ).defaultTextToOverflowHidden();
    } catch {
      overflowHidden = true;
    }
  }

  return overflowHidden;
};

export const nativeTextStyle = (style: unknown): unknown => {
  const hidden = defaultOverflowHidden();

  if (style == null || typeof style !== 'object') {
    return hidden ? TEXT_DEFAULT : style;
  }

  const numeric =
    typeof (style as { fontWeight?: unknown }).fontWeight === 'number';

  if (!hidden && !numeric) {
    return style;
  }

  let copy = textStyles.get(style);

  if (!copy) {
    copy = { ...(hidden ? TEXT_DEFAULT : null), ...style };

    if (numeric) {
      (copy as { fontWeight: string }).fontWeight = String(
        (style as { fontWeight: number }).fontWeight
      );
    }

    textStyles.set(style, copy);
  }

  return copy;
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
    styleIsPlain(resolved, true) &&
    styleIsPlain(props.style)
  );
};
