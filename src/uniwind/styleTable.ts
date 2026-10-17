// Turns Uniwind's stylesheet into data the native class resolver can use (cpp/css/StyleResolver.hpp).
//
// Uniwind compiles every class to a list of styles whose values are JS functions of the theme's CSS variables and of its runtime
// object. A class whose values depend only on the theme (and on what is fixed for the session: pixel ratio, hairline width,
// colour functions) is evaluated here once per theme; every read of a variable and of the runtime's changing fields (screen,
// insets, font scale, ...) is recorded, so this is known, not assumed. Conditions the native resolver checks itself (width,
// theme, pressed / focused / disabled) stay conditions. Every other class is listed as `fallback`: a className that contains one
// is resolved by Uniwind's JS as before. Nothing is approximated: the native result for a className with no fallback class is the
// result Uniwind's resolveStyles gives (cpp/harness/fixtures/resolver checks it against the real one).
//
// No React Native imports: the fixture generator runs this in Node.

type Var = (vars: Record<string, unknown>) => unknown;

// Uniwind 1.12's compiled style (core/types.ts)
export type UniwindStyle = {
  entries: Array<[string, Var]>;
  minWidth: number;
  maxWidth: number;
  orientation: string | null;
  theme: string | null;
  rtl: boolean | null;
  dependencies: number[] | null;
  importantProperties: string[];
  complexity: number;
  active: boolean | null;
  focus: boolean | null;
  disabled: boolean | null;
  dataAttributes: Record<string, string> | null;
};

export type StyleTableInput = {
  stylesheet: Record<string, UniwindStyle[]>;
  /** UniwindStore.vars: the variables of each theme (prototype-chained to the shared ones). */
  varsByTheme: Record<string, Record<string, Var>>;
  themes: readonly string[];
  /**
   * UniwindStore.runtime, the `rt` of every value. `rt.lightDark` reads currentThemeName, so it is set to each theme while that
   * theme is evaluated; its changing fields are watched while the table is built (and restored after).
   */
  runtime: { currentThemeName: string } & Record<string, unknown>;
  /**
   * Runtime fields fixed for a session on a device but unknown where the table is built (at Metro time: `pixelRatio`,
   * `hairlineWidth`). A value that reads one is treated like one reading a changing field, and its class is listed in
   * `deviceDependent`.
   */
  deviceFixed?: readonly string[];
};

// Uniwind 1.12's runtime (core/native/runtime.ts): fields that change while the app runs. A value that reads one is not fixed.
// The others are fixed for the session (hairlineWidth, pixelRatio) or pure (colorMix, parseColor, cubicBezier, lightDark, which
// reads currentThemeName: evaluated per theme).
const CHANGING_RUNTIME = [
  'screen',
  'orientation',
  'insets',
  'rtl',
  'colorScheme',
  'fontScale',
];

export type StyleTable = {
  json: string;
  classes: number;
  fallback: number;
  /** Fallback classes with a value that read a `deviceFixed` field and no changing one: a table built on the device can hold them. */
  deviceDependent: string[];
};

// Uniwind's resolveStyles rewrites these after resolving (parsers/*): the resolver does not, so such a class falls back
const POST_PROCESSED = new Set([
  'boxShadow',
  'fontVariant',
  'experimental_backgroundImage',
  'textShadow',
  'transform',
  'translateX',
  'translateY',
  'translateZ',
  'rotate',
  'rotateX',
  'rotateY',
  'rotateZ',
  'scale',
  'scaleX',
  'scaleY',
  'scaleZ',
  'skewX',
  'skewY',
  'perspective',
]);

const UNDEFINED = { $u: 1 };
const NAN = { $nan: 1 };
const INFINITY = { $inf: 1 };
const MINUS_INFINITY = { $inf: -1 };
const INVALID = Symbol('invalid');

// JSON keeps it exactly: finite numbers, strings, booleans, null, and arrays / plain objects of them
const isPlain = (value: unknown): boolean => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isPlain);
  }

  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);

    return (
      (proto === Object.prototype || proto === null) &&
      Object.values(value as object).every(isPlain)
    );
  }

  return false;
};

export const buildStyleTable = (input: StyleTableInput): StyleTable => {
  const { runtime } = input;
  const runtimeReads = new Set<string>();
  const previousTheme = runtime.currentThemeName;
  const restore: Array<() => void> = [];

  try {
    // every read of a changing runtime field is recorded while the table is built
    for (const key of [...CHANGING_RUNTIME, ...(input.deviceFixed ?? [])]) {
      const descriptor = Object.getOwnPropertyDescriptor(runtime, key);

      if (!descriptor) {
        continue; // not in this Uniwind: nothing reads it
      }

      if (!descriptor.configurable) {
        throw new Error(`cannot watch runtime.${key}`);
      }

      let current = descriptor.get
        ? descriptor.get.call(runtime)
        : descriptor.value;

      Object.defineProperty(runtime, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          runtimeReads.add(key);
          return current;
        },
        set(next) {
          current = next;
        },
      });
      restore.push(() => {
        Object.defineProperty(
          runtime,
          key,
          descriptor.get || descriptor.set
            ? descriptor
            : { ...descriptor, value: current }
        );
      });
    }

    return build(input, runtimeReads);
  } finally {
    restore.forEach((undo) => undo());
    runtime.currentThemeName = previousTheme;
  }
};

const build = (
  input: StyleTableInput,
  runtimeReads: Set<string>
): StyleTable => {
  const { stylesheet, varsByTheme, themes, runtime } = input;
  const deviceFixed = new Set(input.deviceFixed ?? []);
  // getters whose value read device-fixed runtime fields only
  const deviceGetters = new Set<Var>();

  // Evaluates one value getter for one theme, recording every variable it reads. `override` sets one variable the way a class of
  // the className does it in resolveStyles (`vars[name] = getter` on a clone of the theme's variables).
  const evaluate = (
    getter: Var,
    theme: string,
    override?: { name: string; getter: Var }
  ) => {
    const themeVars = varsByTheme[theme];

    if (!themeVars) {
      return null;
    }

    let vars = themeVars;

    if (override) {
      vars = Object.create(themeVars) as Record<string, Var>;
      vars[override.name] = override.getter;
    }

    const reads = new Set<string>();
    const recorder = new Proxy(vars, {
      get(target, key, receiver) {
        if (typeof key === 'string') {
          reads.add(key);
        }

        return Reflect.get(target, key, receiver);
      },
    });

    runtime.currentThemeName = theme;
    runtimeReads.clear();

    try {
      const value = getter(recorder);

      if (runtimeReads.size > 0) {
        if ([...runtimeReads].every((key) => deviceFixed.has(key))) {
          deviceGetters.add(getter);
        }

        return null;
      }

      return { value, reads };
    } catch {
      return null;
    }
  };

  // Variables a class sets inline (Tailwind's `--tw-leading`, `--tw-font-weight`, ...). resolveStyles puts the winning
  // definition of the className into the variables every value of that className reads, so a value that reads one depends on
  // which class of the className defines it. Each definition is a provider; a value reading one variable is evaluated once per
  // provider of that variable (and once with none), and the native resolver picks the provider that wins.
  type Provider = { id: number; name: string; getter: Var; valid: boolean };

  const providers = new Map<string, Provider[]>();
  const providerOf = new Map<Var, Provider>();
  let nextProvider = 0;

  for (const className of Object.keys(stylesheet)) {
    for (const style of stylesheet[className] ?? []) {
      for (const [property, getter] of style.entries) {
        if (property[0] === '-') {
          const provider = {
            id: nextProvider++,
            name: property,
            getter,
            valid: true,
          };

          providers.set(property, [
            ...(providers.get(property) ?? []),
            provider,
          ]);
          providerOf.set(getter, provider);
        }
      }
    }
  }

  // a definition can be chosen natively only if its own value depends on the theme alone
  for (const list of providers.values()) {
    for (const provider of list) {
      for (const theme of themes) {
        const result = evaluate(provider.getter, theme);

        if (
          !result ||
          [...result.reads].some(
            (key) => key === 'currentColor' || providers.has(key)
          )
        ) {
          provider.valid = false;
        }
      }
    }
  }

  // each value with the theme's variables alone, per theme (entryOf starts from these)
  const plainResults = new Map<Var, ReturnType<typeof evaluate>[]>();
  const evaluatePlain = (getter: Var) => {
    let results = plainResults.get(getter);

    if (!results) {
      results = themes.map((theme) => evaluate(getter, theme));
      plainResults.set(getter, results);
    }

    return results;
  };

  // Inline variables some value reads. A value the table holds reads at most one, the same on every path (entryOf checks it), so
  // a variable no value reads here is read by no value at all: its definitions are inert (`--tw-tracking`, the gradient stops
  // without a gradient class) and need no valid value. Post-processed values are skipped: their classes fall back anyway.
  const readVariables = new Set<string>();

  for (const name of Object.keys(stylesheet)) {
    for (const style of stylesheet[name] ?? []) {
      for (const [property, getter] of style.entries) {
        if (property[0] !== '-' && !POST_PROCESSED.has(property)) {
          for (const result of evaluatePlain(getter)) {
            result?.reads.forEach(
              (key) => providers.has(key) && readVariables.add(key)
            );
          }
        }
      }
    }
  }

  const encodeValue = (
    property: string,
    value: unknown
  ): unknown | typeof INVALID => {
    // Uniwind multiplies a lineHeight under 6 by fontSize after resolving: the resolver does it for numbers only
    if (
      property === 'lineHeight' &&
      value !== undefined &&
      typeof value !== 'number'
    ) {
      return INVALID;
    }

    if (value === undefined) {
      return UNDEFINED;
    }

    // `0.025 * undefined` (an em value with no font size), a division by zero: JSON has no NaN or Infinity
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return Number.isNaN(value) ? NAN : value > 0 ? INFINITY : MINUS_INFINITY;
    }

    return isPlain(value) ? value : INVALID;
  };

  // [property, values per theme] | [variable, { def: provider }] | [property, { var, none: values, by: { provider: values } }]
  const entryOf = (property: string, getter: Var): unknown | null => {
    if (POST_PROCESSED.has(property)) {
      return null;
    }

    if (property[0] === '-') {
      const provider = providerOf.get(getter);

      return provider && (provider.valid || !readVariables.has(property))
        ? [property, { def: provider.id }]
        : null;
    }

    const plain: unknown[] = [];
    let readVariable: string | null = null;

    for (const result of evaluatePlain(getter)) {
      if (!result || result.reads.has('currentColor')) {
        return null;
      }

      const inline = [...result.reads].filter((key) => providers.has(key));

      if (
        inline.length > 1 ||
        (readVariable !== null &&
          inline.length === 1 &&
          inline[0] !== readVariable)
      ) {
        return null;
      }

      readVariable = inline[0] ?? readVariable;

      const encoded = encodeValue(property, result.value);

      if (encoded === INVALID) {
        return null;
      }

      plain.push(encoded);
    }

    if (readVariable === null) {
      return [property, plain];
    }

    const by: Record<string, unknown[]> = {};

    for (const provider of providers.get(readVariable)!) {
      if (!provider.valid) {
        continue; // a className with this provider's class falls back as a whole
      }

      const values: unknown[] = [];

      for (const theme of themes) {
        const result = evaluate(getter, theme, provider);

        if (
          !result ||
          result.reads.has('currentColor') ||
          [...result.reads].some(
            (key) => key !== readVariable && providers.has(key)
          )
        ) {
          return null;
        }

        const encoded = encodeValue(property, result.value);

        if (encoded === INVALID) {
          return null;
        }

        values.push(encoded);
      }

      by[provider.id] = values;
    }

    return [property, { var: readVariable, none: plain, by }];
  };

  const evaluateClass = (styles: UniwindStyle[]): unknown[] | null => {
    const out: unknown[] = [];

    for (const style of styles) {
      // conditions the resolver does not check; Infinity is the only width JSON cannot carry (as null: maxWidth only)
      if (
        style.dataAttributes !== null ||
        style.orientation !== null ||
        style.rtl !== null ||
        !Number.isFinite(style.minWidth) ||
        !(Number.isFinite(style.maxWidth) || style.maxWidth === Infinity) ||
        !Number.isFinite(style.complexity)
      ) {
        return null;
      }

      const entries: unknown[] = [];

      for (const [property, getter] of style.entries) {
        const entry = entryOf(property, getter);

        if (entry === null) {
          return null;
        }

        entries.push(entry);
      }

      out.push({
        minWidth: style.minWidth,
        maxWidth: style.maxWidth === Infinity ? null : style.maxWidth,
        theme: style.theme,
        active: style.active,
        focus: style.focus,
        disabled: style.disabled,
        complexity: style.complexity,
        important: style.importantProperties,
        // copied, not interpreted: the values do not read what they name (or the class fell back above)
        deps: style.dependencies ?? [],
        entries,
      });
    }

    return out;
  };

  const classes: Record<string, unknown[]> = {};
  const fallback: string[] = [];
  const deviceDependent: string[] = [];

  for (const name of Object.keys(stylesheet)) {
    const styles = stylesheet[name];
    const out = Array.isArray(styles) ? evaluateClass(styles) : null;

    if (out) {
      classes[name] = out;
    } else {
      fallback.push(name);

      if (
        Array.isArray(styles) &&
        styles.some((style) =>
          style.entries.some(([, getter]) => deviceGetters.has(getter))
        )
      ) {
        deviceDependent.push(name);
      }
    }
  }

  const json = JSON.stringify({
    version: 2,
    themes,
    // `name in stylesheet` is also true for these (Object.prototype): Uniwind's resolveStyles then iterates a function and throws.
    // The resolver falls back for them, so whatever Uniwind does still happens.
    reserved: Object.getOwnPropertyNames(Object.prototype),
    fallback,
    classes,
  });

  return {
    json,
    classes: Object.keys(classes).length,
    fallback: fallback.length,
    deviceDependent,
  };
};
