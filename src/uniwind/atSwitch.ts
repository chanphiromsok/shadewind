import { createElement, type ComponentType, type ReactNode } from 'react';
import type { ThemedStyles } from '../internal';
import { NativeView } from './native';

// Register at switch (experimental, off by default). Instead of a ref callback per themed view that registers it with the engine at
// mount, View and Text put their per-theme styles on the host element as an extra prop, `$sw`. React Native filters props through the
// view config before they reach native, so it costs nothing there, but it stays on the committed fiber (`memoizedProps`). When the
// theme is about to change, the committed tree is walked once, every host fiber that carries `$sw` is bound to the engine with its
// shadow node, and the engine switches as before.
//
// Turned on with `globalThis.__SHADEWIND_REGISTER_AT_SWITCH__ = true` before the app's first render (docs/ARCHITECTURE.md section 22).
// Everything that touches React's fibers (a private API: tags, child / sibling / return, stateNode, memoizedProps) is in this file.

/** The flag, read once: it is a launch-time switch. */
let flag: boolean | undefined;

export const atSwitchEnabled = (): boolean =>
  (flag ??=
    (globalThis as { __SHADEWIND_REGISTER_AT_SWITCH__?: boolean })
      .__SHADEWIND_REGISTER_AT_SWITCH__ === true);

/** The props to spread on a host element: its styles under `$sw`, or nothing. A new object only for a view the engine takes. */
export const swProps = (themed: ThemedStyles | null): object | undefined =>
  themed !== null && atSwitchEnabled() ? { $sw: themed } : undefined;

// The parts of a React fiber this file reads.
type HostInstance = { node: unknown; canonical?: object };
export type Fiber = {
  tag: number;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  stateNode: unknown;
  memoizedProps: { $sw?: ThemedStyles } | null;
};
type FiberRoot = { current: Fiber };

const HOST_ROOT = 3;
const HOST_COMPONENT = 5;

type Engine = {
  bindHost(
    key: object,
    node: unknown,
    styles: ThemedStyles,
    renderTheme?: string
  ): boolean;
  isHostBound(key: object): boolean;
  unbindHost(key: object, node: unknown): void;
};

/** Fiber roots with a wrapper mounted (one per running app root). */
const roots = new Set<FiberRoot>();

/** The FiberRoot of a fiber: up `return` to the HostRoot (either copy of it, the root object is the same), then its stateNode. */
export const fiberRootOf = (fiber: Fiber): FiberRoot | null => {
  let node: Fiber | null = fiber;

  while (node && node.tag !== HOST_ROOT) {
    node = node.return;
  }

  return node ? (node.stateNode as FiberRoot) : null;
};

/**
 * Calls `visit` for every host fiber of the tree that `root.current` holds: the committed tree. `root.current` changes with every
 * commit (React builds the next tree on the alternate fibers), and a fiber's `return` can point at the alternate parent, so the
 * traversal goes down with child / sibling and an explicit stack, never up.
 */
export const walkCommitted = (
  root: FiberRoot,
  visit: (fiber: Fiber) => void
): void => {
  const parents: Fiber[] = [];
  let node: Fiber | null = root.current.child;

  for (;;) {
    while (node) {
      if (node.tag === HOST_COMPONENT) {
        visit(node);
      }

      if (node.child) {
        parents.push(node);
        node = node.child;
      } else {
        node = node.sibling;
      }
    }

    const parent = parents.pop();

    if (!parent) {
      return;
    }

    node = parent.sibling;
  }
};

/**
 * The walk, run before a theme switch: binds every host fiber with `$sw` (a view bound to the same styles already costs a lookup),
 * and unbinds one that was bound and has none now (a pressed view, a className that left the engine).
 * `renderThemeOf`: the theme a styles object was resolved for, i.e. the one React rendered the view's props with.
 */
export const bindCommitted = (
  engine: Engine,
  renderThemeOf: WeakMap<object, string>
): void => {
  if (roots.size === 0) {
    if (__DEV__) {
      console.warn(
        '[shadewind] register at switch: no app root is known, nothing was bound (does another AppRegistry.setWrapperComponentProvider replace the one shadewind sets?)'
      );
    }

    return;
  }

  for (const root of roots) {
    walkCommitted(root, (fiber) => {
      const instance = fiber.stateNode as HostInstance | null;
      const key = instance?.canonical;

      if (!key) {
        return;
      }

      const themed = fiber.memoizedProps?.$sw;

      if (themed) {
        engine.bindHost(key, instance.node, themed, renderThemeOf.get(themed));
      } else if (engine.isHostBound(key)) {
        engine.unbindHost(key, instance.node);
      }
    });
  }
};

// The root wrapper: one host view per app root whose ref is a way to the FiberRoot. It lays out like the app container it wraps.
const FILL = { flex: 1 } as const;

const makeRootRef = () => {
  let mine: FiberRoot | null = null;

  return (instance: unknown) => {
    if (mine) {
      roots.delete(mine);
      mine = null;
    }

    const handle = (instance as { __internalInstanceHandle?: Fiber } | null)
      ?.__internalInstanceHandle;
    const root = handle ? fiberRootOf(handle) : null;

    if (root) {
      mine = root;
      roots.add(root);
    }
  };
};

type WrapperProvider = (appParameters: unknown) => unknown;

const wrapperFor = (inner: unknown) => {
  const rootRef = makeRootRef();
  const Inner = inner as ComponentType<{ children?: ReactNode }> | null;

  return ({ children }: { children?: ReactNode }) =>
    createElement(
      NativeView,
      {
        ref: rootRef,
        collapsable: false,
        pointerEvents: 'box-none',
        style: FILL,
      },
      Inner ? createElement(Inner, null, children) : children
    );
};

let installed = false;

/**
 * Wraps every app root in a host view that gives the walk its FiberRoot, through AppRegistry.setWrapperComponentProvider. That
 * function has no getter and keeps one provider, so an app's own provider is kept by taking over the setter: a provider set after
 * this call is composed inside ours, one set before it is replaced (documented). Call before the app runs (runApplication).
 */
export const installRootTracking = (): boolean => {
  if (installed) {
    return true;
  }

  const registry = (
    require('react-native') as {
      AppRegistry: {
        setWrapperComponentProvider(provider: WrapperProvider): void;
      };
    }
  ).AppRegistry;
  const original = registry.setWrapperComponentProvider.bind(registry);
  let user: WrapperProvider | undefined;
  const provide: WrapperProvider = (params) =>
    wrapperFor(user ? user(params) : null);

  original(provide);

  try {
    registry.setWrapperComponentProvider = (provider) => {
      user = provider;
      original(provide);
    };
  } catch {
    // a frozen namespace: ours stays, an app's own provider (if it sets one) replaces it
    if (__DEV__) {
      console.warn(
        '[shadewind] register at switch: AppRegistry.setWrapperComponentProvider cannot be wrapped; do not set another provider'
      );
    }
  }

  installed = true;

  return true;
};
