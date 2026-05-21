# babel-preset-plastic

A Babel preset that compiles JSX into calls against a Plastic-shaped reactive
runtime. It bundles two plugins:

- **`controlFlow`** (`transform-jsx-control-flow`) — lifts `<Either>`, `<Match>`,
  and `<Context.Provider>` branches onto lazy arrow-function props so inactive
  branches never run.
- **`reactive`** (`transform-jsx-reactive`) — rewrites every JSX element into
  `jsx(Tag, mergeProps(...))` and emits dynamic attribute values as getters
  for fine-grained reactivity.

## Install

```sh
npm i -D babel-preset-plastic
```

`@babel/core` is a peer dependency. The emitted code imports from
`@plastic-js/plastic/jsx-runtime`, so the host project must also install
`@plastic-js/plastic` (or the runtime you configure).

## Usage

Use as a Babel **preset** — it bundles both plugins in the correct order:

```js
// babel.config.js
import plastic from 'babel-preset-plastic'

export default {
  presets: [plastic],
}
```

### Ordering with `@babel/preset-react`

`babel-preset-plastic` rewrites every `JSXElement` / `JSXFragment` itself, so
`@babel/preset-react` is **not required** for this preset to work. If you do
include `@babel/preset-react` in the same config (e.g. for other tooling),
list `babel-preset-plastic` **first** so the JSX is consumed by the reactive
transform before the React preset sees it:

```js
export default {
  presets: [
    plastic,             // runs last in source order, first in pass order
    '@babel/preset-react' // effectively a no-op once Plastic has run
  ],
}
```

Babel runs presets in **reverse order**, so the entry that appears first in
the array runs last. In the example above Plastic still rewrites JSX before
`preset-react` ever observes a JSX node — but the cleanest setup is to drop
`@babel/preset-react` entirely.

### Importing individual plugins

```js
import { controlFlow, reactive } from 'babel-preset-plastic'
// or
import controlFlow from 'babel-preset-plastic/control-flow'
import reactive from 'babel-preset-plastic/reactive'
```

## Ordering invariant

`controlFlow` **must** run before `reactive`. The control-flow pass synthesizes
`trueBranch`, `falseBranch`, `cases`, `defaultBranch`, and `children` props
that the reactive pass then converts to `mergeProps` form. Reversing the order
produces a quietly broken build (eager branch evaluation). The preset wires
them in the correct order automatically.

## What each plugin does

### `transform-jsx-control-flow`

Lifts branches out of JSX `children` and onto arrow-function props so inactive
branches stay lazy.

```jsx
// <Either> — binary conditional
<Either condition={expr}>
  <True>…</True>
  <False>…</False>
</Either>

// becomes
<Either condition={expr}
  trueBranch={()  => …}
  falseBranch={() => …}
/>
```

```jsx
// <Match> — multi-branch switch
<Match value={expr}>
  <Case when={a}>…</Case>
  <Case when={b}>…</Case>
  <Default>…</Default>
</Match>

// becomes
<Match value={expr}
  cases={[
    { when: a, branch: () => … },
    { when: b, branch: () => … },
  ]}
  defaultBranch={() => …}
/>
```

```jsx
// <X.Provider> — any JSXMemberExpression ending in `.Provider`
<MyContext.Provider value={v}>…children…</MyContext.Provider>

// becomes
<MyContext.Provider value={v} children={() => …children…} />
```

`<True>` / `<False>` / `<Default>` are compile-time slot markers; their
wrappers are stripped — the arrow body is the meaningful payload directly. The
`when` attribute on `<Case>` is hoisted onto the descriptor and removed from
the wrapper. The pass is idempotent: running it twice is safe.

#### Slot-body unwrap rules

| Slot children (after whitespace filter) | Result |
|---|---|
| 0 meaningful children | `null` literal |
| 1 child, `JSXElement` / `JSXFragment` | the element itself |
| 1 child, `JSXExpressionContainer` | its inner expression |
| 1 child, `JSXText` / `JSXSpreadChild` | wrapped in a fragment |
| 2+ children | wrapped in a fragment |

### `transform-jsx-reactive`

Replaces `@babel/preset-react`'s automatic-runtime output with a Plastic-shaped
call: every JSX element becomes `jsx(Tag, mergeProps(...args))` so the runtime
sees a single reactive proxy per element regardless of how many spreads or
sibling attributes appear. Dynamic attribute values become getter properties;
the runtime's binding effect observes signal reads when it reads the proxy.

```jsx
// Source
<MyComp {...api()} foo={2} bar={state.b}>{kid}</MyComp>

// Output
jsx(MyComp, mergeProps(
  () => api(),
  {
    foo: 2,
    get bar() { return state.b },
    children: () => kid,
  },
))
```

#### Static vs. reactive classification

`isStaticExpression` decides whether to emit a plain property or a getter.

- **Always static**: string / numeric / boolean / null / bigint / regexp
  literals, identifiers, `this`, arrow and function expressions.
- **Always reactive**: member access, call / new / tagged-template / optional
  call, await, yield, assignment, update.
- **Recursive cases**: unary, binary, logical, conditional, template literals,
  array / object expressions, sequence expressions — static iff every
  sub-expression is static.
- **JSX**: a `JSXElement` is always reactive; a `JSXFragment` is static iff
  its children are whitespace-only.

Identifiers are treated as static deliberately because the runtime detects
signal identifiers on its own; reactive trees (from `createTree`) are
inherently reactive without compile-time help.

#### Argument grouping

`buildMergePropsArgs` walks attributes in source order and groups consecutive
non-spread attributes into one `ObjectExpression`; spreads remain positional.
This preserves JSX prop-order semantics:

- For ordinary keys, later sources override earlier ones.
- `class` / `className` / `style` are additively merged at runtime.
- `ref` and `onXxx` follow last-source-wins.

Dynamic spread sources (`{...api()}`) are wrapped in a thunk so `mergeProps`
can re-evaluate them on each reactive read. Static spread sources (plain
identifiers, object literals) are passed through directly.

#### Children

`children` is injected as a property on the trailing object group.

- Whitespace-only `JSXText` is dropped — except inside `<pre>`, `<textarea>`,
  `<code>`, `<script>`, `<style>`, where raw text is preserved.
- Non-whitespace-sensitive `JSXText` has runs of whitespace collapsed to
  single spaces.
- Dynamic `JSXExpressionContainer` children are wrapped in `() => expr`.
- `JSXSpreadChild` becomes a `SpreadElement`.
- `JSXElement` is left as-is; the visitor itself rewrites it to `jsx(...)`.

#### Duplicate-attribute detection

If the same attribute name appears twice on one element, the plugin throws a
build error:

```
[transform-jsx-reactive] duplicate attribute "id" on <div> at file.jsx:12:7
```

- Scope is the element itself — spreads between two same-named attrs do not
  hide the duplicate.
- Spreads themselves contribute no names.
- `class`, `className`, `style` are whitelisted because their additive merge
  semantics make repetition legitimate.

#### Tag-name handling

- Lower-case bare identifiers → string literal (intrinsic DOM tag).
- Upper-case bare identifiers → JS identifier (component reference).
- `JSXMemberExpression` (`Theme.Provider`, `ark.div`) → `MemberExpression`.
- `JSXNamespacedName` (`xlink:href` as a tag) → string literal.

#### Attribute-name handling

`jsxNameToKey` emits a plain `Identifier` for valid JS identifier names and a
`StringLiteral` for anything else (`aria-foo`, `data-bar`, `xlink:href`, etc.).

#### Fragment fast path

`JSXFragment` skips `mergeProps` entirely:

```js
jsx(Fragment, { children: [...] })
```

## Runtime contract

Emitted code imports `jsx`, `Fragment`, and `mergeProps` from
`@plastic-js/plastic/jsx-runtime`. The host project must provide that module:

| Export | Purpose |
|---|---|
| `jsx` | `jsx(Tag, props)` — creates the element / component instance. |
| `mergeProps` | Proxy-based prop merger that observes signal reads via getters. |
| `Fragment` | Marker tag for `<>…</>`. |

Components consumed by the control-flow output additionally need:

| Component | Required props |
|---|---|
| `Either` | `condition`, `trueBranch`, `falseBranch` (arrow functions returning JSX or `null`). |
| `Match` | `value`, `cases: { when, branch }[]`, `defaultBranch`. |
| `<X.Provider>` | `value`, `children: () => JSX`. |

## License

MIT
