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

#### Compile-time fast paths

The reactive plugin probes each `JSXElement` against two optimizations before
falling back to the generic `jsx(Tag, mergeProps(...))` form. They cascade —
the template path is tried first, then `jsxStatic`, then the generic path.

##### 1. Template / `cloneNode` path (foldable subtrees)

A JSX subtree built from intrinsic tags with plain attribute names can be
serialized to an HTML string at build time. The runtime parses that string
once per module into a hoisted `<template>` element, and each render site
clones it instead of running `createElement` / `setAttribute` / `appendChild`
node-by-node.

A `JSXElement` is **foldable** when:

- The tag is a lowercase `JSXIdentifier` (intrinsic DOM tag).
- It has no `JSXSpreadAttribute`s.
- Every attribute name is a plain `JSXIdentifier` (no `xlink:href`-style
  `JSXNamespacedName` keys).

Attribute *values* and *children* are unrestricted — literals fold into the
HTML; dynamic expressions become "holes" patched at mount. Non-foldable
children (components, fragments, spread children, elements with spreads or
namespaced attrs) become `insert` holes whose JSX is re-traversed by Babel and
handled by the normal `jsx` pipeline.

The pass fires only at the **topmost** foldable element; nested foldable
descendants get folded into the same template during `compileTemplatePlan`.

Three output shapes, depending on the plan:

- **Pure-static subtree** (zero dynamic holes) — replaced inline with a single
  expression, no IIFE:
  ```jsx
  // Source
  <div class="card">
    <h1>Hello</h1>
    <p>Welcome</p>
  </div>

  // Output (template hoisted to module scope)
  _tmpl$1.cloneNode(true)
  ```

- **Mixed static + dynamic** — wrapped in an IIFE that clones the template,
  declares locals via pre-computed DOM navigation (`firstChild`/`nextSibling`),
  patches holes, and returns the root. Each "local" is a const binding for a
  cloned node the patching code needs to touch. Each non-root local is
  declared by navigating from its **nearest already-declared ancestor** to
  keep navigation chains short:
  ```jsx
  // Source
  <p>Welcome, {name}</p>

  // Output
  (() => {
    const _el0 = _tmpl$1.cloneNode(true)
    const _el1 = _el0.firstChild.nextSibling   // the `<!>` marker
    insert(_el0, () => name, _el1)
    return _el0
  })()
  ```

- **Dynamic attribute holes** — emit `setProp(el, key, accessor)` calls in
  addition to (or instead of) `insert` calls.

`className` and `htmlFor` are rewritten to `class` and `for` when baked into
the HTML string. Whitespace-sensitive tags (`<pre>`, `<textarea>`, `<code>`,
`<script>`, `<style>`) preserve raw text inside the template; all other tags
collapse `JSXText` whitespace to single spaces. Void elements (`<br>`,
`<img>`, etc.) are serialized without a closing tag. Identical template HTML
across the file is deduplicated to a single hoisted node.

Dynamic-child holes use a `<!>` comment marker for position anchoring unless
the dynamic expression is the only meaningful child of its parent, in which
case the marker is omitted and `insert(parent, accessor)` is called without
an anchor.

##### 2. `jsxStatic` path (single intrinsic element, all-literal attrs)

When an element is not foldable as a subtree but its own attributes are all
literal-static, the plugin emits `jsxStatic(tag, propsLiteral, children?)`.
The runtime applies the props object directly with no reactive getters or
`mergeProps` overhead. Children still flow through the normal `jsx` pipeline
— they may themselves be reactive expressions or further `jsx(...)` subtrees.

```jsx
// Source
<div id="root" class="page">{dynamicChild}</div>

// Output (children are not all literal, so subtree isn't foldable here)
jsxStatic('div', { id: 'root', class: 'page' }, dynamicChild)
```

Qualifies when:

- Tag is a lowercase `JSXIdentifier`.
- No `JSXSpreadAttribute`s.
- Every attribute value is a literal (string / numeric / boolean / null /
  bare boolean attr).

A single meaningful child is passed positionally; multiple children are
passed as an array.

## Runtime contract

Emitted code imports from `@plastic-js/plastic/jsx-runtime`. The host project
must provide that module:

| Export | Purpose |
|---|---|
| `jsx` | `jsx(Tag, props)` — creates the element / component instance. |
| `mergeProps` | Proxy-based prop merger that observes signal reads via getters. |
| `Fragment` | Marker tag for `<>…</>`. |
| `jsxStatic` | `jsxStatic(tag, props, children?)` — non-reactive prop application for the all-literal-attrs fast path. |
| `template` | `template(htmlString)` — parses the HTML once and returns a node to `cloneNode(true)`. |
| `setProp` | `setProp(el, key, accessor)` — reactive attribute patcher for template holes. |
| `insert` | `insert(parent, accessor, marker?)` — reactive child inserter for template holes; uses the optional marker as a positional anchor. |

Components consumed by the control-flow output additionally need:

| Component | Required props |
|---|---|
| `Either` | `condition`, `trueBranch`, `falseBranch` (arrow functions returning JSX or `null`). |
| `Match` | `value`, `cases: { when, branch }[]`, `defaultBranch`. |
| `<X.Provider>` | `value`, `children: () => JSX`. |

## License

MIT
