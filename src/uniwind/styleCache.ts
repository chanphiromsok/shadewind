// A bounded replacement for Uniwind 1.12's style cache (UniwindStore.getStyles, core/native/store.ts), installed on the store instance
// like the native resolver (an own property in front of the prototype's method). Same key, same per-theme Maps (`store.cache`), same
// rule for what is cached (not a result with data attributes), same invalidation (an entry goes when one of its dependencies notifies),
// with two differences:
//
// - one invalidation listener per dependency, subscribed once, instead of a `UniwindListener.subscribe(..., { once: true })` per entry.
//   That subscription is most of what an entry costs on Hermes (about 1.2 of 1.7 KB for a theme-dependent className: a Map, a dispose
//   closure and a closure per dependency, kept in the listener Sets until the dependency notifies; a className without dependencies
//   has none);
// - at most `limit` entries per theme: the oldest goes first. An entry dropped while views still use it is resolved again on their next
//   render (a new object with the same values: React sends the style again; nothing else depends on the identity).
//
// Without this every distinct className stays cached for the life of the app (until a theme switch for a theme-dependent one), which
// grows without bound for classNames built from unbounded values (`w-[${px}px]`).

type Result = {
  styles: Record<string, unknown>;
  dependencies: number[];
  dependencySum: number;
  hasDataAttributes?: boolean;
};

type Context = {
  scopedTheme: string | null;
  rtl?: boolean | null;
  variables?: { __uniwindVariablesCacheKey?: string } | null;
};

type Store = {
  cache: Record<string, Map<string, Result>>;
  runtime: { currentThemeName: string };
  resolveStyles: (
    className: string,
    props: unknown,
    state: unknown,
    context: Context
  ) => Result;
  getStyles: (
    className: string | undefined,
    props: unknown,
    state: any,
    context: Context
  ) => Result;
};

type Listener = {
  subscribe: (listener: () => void, dependencies: number[]) => () => void;
};

export const STYLE_CACHE_LIMIT = 4096;

let installed = false;

/** Returns false (and leaves Uniwind's own cache) when the store is not shaped like Uniwind 1.12's. */
export function installBoundedStyleCache(
  target: unknown,
  listener: Listener,
  dependencies: Record<string, unknown>,
  limit = STYLE_CACHE_LIMIT
): boolean {
  if (installed) {
    return true;
  }

  const store = target as Store;
  const prototype = Object.getPrototypeOf(store) as Partial<Store> | null;

  if (
    typeof prototype?.getStyles !== 'function' ||
    store.getStyles !== prototype.getStyles ||
    typeof store.resolveStyles !== 'function' ||
    typeof store.cache !== 'object' ||
    store.cache === null ||
    !Object.values(store.cache).every((cache) => cache instanceof Map)
  ) {
    return false;
  }

  // Uniwind's own empty result (one object, returned for no className), so callers keep seeing the same object
  const emptyState = prototype.getStyles.call(
    store,
    undefined,
    undefined,
    undefined,
    {
      scopedTheme: null,
    }
  );

  store.getStyles = function getStyles(
    this: Store,
    className,
    componentProps,
    state,
    uniwindContext
  ) {
    if (className === undefined || className === '') {
      return emptyState;
    }

    const isScopedTheme = uniwindContext.scopedTheme !== null;
    // Uniwind 1.12's key, character for character
    const cacheKey = `${className}${state?.isDisabled ?? false}${state?.isFocused ?? false}${state?.isPressed ?? false}${isScopedTheme}${
      uniwindContext.rtl ?? ''
    }${uniwindContext.variables?.__uniwindVariablesCacheKey ?? ''}`;
    const cache =
      this.cache[uniwindContext.scopedTheme ?? this.runtime.currentThemeName];

    if (!cache) {
      return emptyState;
    }

    const hit = cache.get(cacheKey);

    if (hit !== undefined) {
      return hit;
    }

    const result = this.resolveStyles(
      className,
      componentProps,
      state,
      uniwindContext
    );

    if (!result.hasDataAttributes) {
      // a loop: entries Uniwind's own method made before this was installed can leave the Map above the limit
      while (cache.size >= limit) {
        cache.delete(cache.keys().next().value!);
      }

      cache.set(cacheKey, result);
    }

    return result;
  };

  // Subscribed now, before any view: within a notify the entries go before any view's re-render runs (Uniwind's own per-entry
  // listeners run in the order the entries were made; a re-render only schedules a React update either way).
  for (const value of Object.values(dependencies)) {
    if (typeof value !== 'number') {
      continue;
    }

    // Uniwind's dependencySum is a bit set
    // eslint-disable-next-line no-bitwise
    const bit = 1 << value;

    listener.subscribe(() => {
      // `store.cache` is read here: Uniwind's reinit (a CSS reload in development) replaces it
      for (const cache of Object.values(store.cache)) {
        for (const [key, result] of cache) {
          // eslint-disable-next-line no-bitwise
          if ((result.dependencySum & bit) !== 0) {
            cache.delete(key);
          }
        }
      }
    }, [value]);
  }

  installed = true;

  return true;
}
