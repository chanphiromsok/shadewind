'use strict';

// shadewind/metro `precompileClassNames: true`. A Babel plugin, added by metro-babel-transformer.cjs to the app's own
// files (not node_modules, not shadewind's src / lib) on iOS and Android, that compiles the simplest styled elements:
//
//   import { View, Text } from 'react-native';                  // or from 'shadewind/uniwind'
//   <View key={i} className="h-25 w-[32%] bg-bench-primary">     ->  <_SwView key={i}>
//     <Text className="text-2xl font-bold">{i}</Text>            ->    <_SwText>{i}</_SwText>
//   </View>                                                      ->  </_SwView>
//
//   import { precompiled as _sw } from 'shadewind/uniwind';      // added
//   const _SwView = _sw.view("h-25 w-[32%] bg-bench-primary");   // added, once per className and file, after the imports
//   const _SwText = _sw.text("text-2xl font-bold");
//
// The values are NOT resolved here: src/uniwind/precompiled.tsx resolves each className once at run time with Uniwind's own store
// (see there for why, and for the contract of the option). This pass only decides which elements are simple enough, from syntax:
//
// - the element is `View` or `Text`, an import binding (renamed imports work, a shadowing local does not match) from
//   'react-native' (Uniwind's resolver turns it into the adapter's component in app code) or 'shadewind/uniwind';
// - `className` is one string literal (or a template literal without expressions), not empty;
// - no spread attribute, no `style`, no `ref`, no namespaced attribute;
// - View: none of the props React Native's View.js rewrites (the adapter then uses View.js too: native.ts VIEW_TRANSFORMED);
// - Text: only the props the adapter's direct host path allows (native.ts TEXT_PLAIN): numberOfLines, testID, ellipsizeMode
//   (and `key`). Press handlers, `disabled`, selectionColorClassName, accessibility props: not compiled.
//
// Anything else is left exactly as written. A file where nothing matches is returned untouched (no import added).

const SOURCES = new Set(['react-native', 'shadewind/uniwind']);
const KINDS = { View: 'view', Text: 'text' };
// native.ts VIEW_TRANSFORMED (React Native 0.86 View.js)
const VIEW_TRANSFORMED = new Set([
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
]);
// native.ts TEXT_PLAIN without style / ref (not compiled), plus `key` (not a prop)
const TEXT_ALLOWED = new Set(['className', 'children', 'numberOfLines', 'testID', 'ellipsizeMode', 'key']);
const RUNTIME = 'shadewind/uniwind';
// a className that is an expression: the attribute stays on the element, the component reads it from its props
const DYNAMIC = Symbol('dynamic');

module.exports = function shadewindPrecompile({ types: t }) {
  // 'view' | 'text' for an element whose name is the View / Text import, null otherwise
  const kindOf = (path) => {
    const name = path.node.openingElement.name;

    if (!t.isJSXIdentifier(name)) {
      return null;
    }

    const binding = path.scope.getBinding(name.name);

    if (!binding || binding.kind !== 'module' || !binding.path.isImportSpecifier()) {
      return null;
    }

    const declaration = binding.path.parentPath.node;
    const specifier = binding.path.node;
    const imported = t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value;

    if (
      !SOURCES.has(declaration.source.value) ||
      declaration.importKind === 'type' ||
      specifier.importKind === 'type' ||
      !Object.prototype.hasOwnProperty.call(KINDS, imported)
    ) {
      return null;
    }

    return KINDS[imported];
  };

  const literalOf = (value) => {
    if (t.isStringLiteral(value)) {
      return value.value;
    }

    if (t.isJSXExpressionContainer(value)) {
      const expression = value.expression;

      if (t.isStringLiteral(expression)) {
        return expression.value;
      }

      if (t.isTemplateLiteral(expression) && expression.expressions.length === 0) {
        return expression.quasis[0].value.cooked ?? null;
      }
    }

    return null;
  };

  // the className literal of a compilable element, or null
  const classNameOf = (path, kind) => {
    let className = null;

    for (const attribute of path.node.openingElement.attributes) {
      if (!t.isJSXAttribute(attribute) || !t.isJSXIdentifier(attribute.name)) {
        return null; // spread or namespaced
      }

      const name = attribute.name.name;

      if (name === 'className') {
        if (className !== null) {
          return null;
        }

        className = literalOf(attribute.value);

        if (className === null) {
          // any other expression (`cn(...)`, a conditional, a variable): resolved at run time per distinct string, see precompiled.tsx
          if (
            t.isJSXExpressionContainer(attribute.value) &&
            !t.isJSXEmptyExpression(attribute.value.expression)
          ) {
            className = DYNAMIC;
          } else {
            return null;
          }
        }
      } else if (name === 'style' || name === 'ref') {
        return null;
      } else if (kind === 'view' ? VIEW_TRANSFORMED.has(name) : !TEXT_ALLOWED.has(name)) {
        return null;
      }
    }

    return className === DYNAMIC || (className !== null && className.trim() !== '') ? className : null;
  };

  return {
    name: 'shadewind-precompile',
    visitor: {
      Program(program, state) {
        const compiled = new Map(); // `${kind} ${className}` -> identifier
        let runtime = null;
        let count = 0;

        // before every other plugin (the JSX transform, TypeScript's import elision): on Program enter, in one pass of our own
        program.traverse({
          JSXElement(path) {
            const kind = kindOf(path);
            const className = kind && classNameOf(path, kind);

            if (!className) {
              return;
            }

            runtime ??= program.scope.generateUidIdentifier('sw');

            const dynamic = className === DYNAMIC;
            const key = dynamic ? `${kind}*` : `${kind} ${className}`;
            let id = compiled.get(key);

            if (!id) {
              id = program.scope.generateUidIdentifier(kind === 'view' ? 'SwView' : 'SwText');
              compiled.set(key, id);
            }

            const opening = path.node.openingElement;

            if (!dynamic) {
              opening.attributes = opening.attributes.filter(
                (attribute) => !(t.isJSXIdentifier(attribute.name) && attribute.name.name === 'className')
              );
            }
            opening.name = t.jsxIdentifier(id.name);

            if (path.node.closingElement) {
              path.node.closingElement.name = t.jsxIdentifier(id.name);
            }

            count++;
          },
        });

        if (count === 0) {
          return;
        }

        const declarations = [...compiled].map(([key, id]) => {
          const dynamic = key.endsWith('*');
          const space = key.indexOf(' ');

          return t.variableDeclaration('const', [
            t.variableDeclarator(
              id,
              t.callExpression(
                t.memberExpression(t.cloneNode(runtime), t.identifier(dynamic ? key.slice(0, -1) : key.slice(0, space))),
                dynamic ? [] : [t.stringLiteral(key.slice(space + 1))]
              )
            ),
          ]);
        });
        const body = program.get('body');
        const lastImport = body.filter((statement) => statement.isImportDeclaration()).pop();
        const imported = t.importDeclaration(
          [t.importSpecifier(t.cloneNode(runtime), t.identifier('precompiled'))],
          t.stringLiteral(RUNTIME)
        );

        if (lastImport) {
          lastImport.insertAfter([imported, ...declarations]);
        } else {
          program.unshiftContainer('body', [imported, ...declarations]);
        }

        // the bindings and references of what was added and renamed: TypeScript's import elision runs after this and removes an
        // import it sees no value reference to
        program.scope.crawl();

        if (state.file && state.file.metadata) {
          state.file.metadata.shadewindPrecompiled = count;
        }
      },
    },
  };
};
