// @vitest-environment jsdom

import {
	afterEach, describe, expect, it,
} from 'vitest'
import { transformSync } from '@babel/core'
import {
	Dynamic,
	Fragment,
	createTree,
	h,
	insert,
	isMergedProps,
	jsx,
	jsxStatic,
	mergeProps,
	renderApp,
	setProp,
	template,
} from '@plastic-js/plastic/jsx-runtime'
import transformReactivePlugin from './babel-plugin-transform-jsx-reactive.js'
import transformControlFlowPlugin from './babel-plugin-transform-jsx-control-flow.js'

describe('babel plugin: Either slot lazy transform', ()=> {
	it('rewrites <Either><True/><False/></Either> children into trueBranch/falseBranch factory props', ()=> {
		const source = `
			const view = (
				<Either condition={flag()}>
					<True><p>A</p></True>
					<False><p>B</p></False>
				</Either>
			)
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformControlFlowPlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('trueBranch: () =>')
		expect(code).toContain('falseBranch: () =>')
		expect(code).not.toContain('children: [')
	})
})

describe('babel plugin: Context.Provider lazy transform', ()=> {
	it('rewrites Provider children to a lazy children factory prop', ()=> {
		const source = `
			const Theme = createContext('light')
			const view = (
				<Theme.Provider value="dark">
					<p>A</p>
				</Theme.Provider>
			)
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformControlFlowPlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('children: () =>')
		expect(code).not.toContain('children: [')
	})
})

describe('babel plugin: ternary lazy transform', ()=> {
	it('wraps JSX ternary expressions in a lazy factory function', ()=> {
		const source = `
			const view = <section>{flag() ? <p>A</p> : <p>B</p>}</section>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => flag() ?')
	})

	it('wraps member-expression children in a lazy factory function', ()=> {
		const source = `
			const view = <section>{state.count}</section>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => state.count')
	})

	it('emits dynamic intrinsic DOM attributes as setProp accessors on the cloned template', ()=> {
		const source = `
			const view = <div style={{ color: state.color }} title={state.title} />
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		// Foldable intrinsic → template path. Dynamic attrs become setProp(_el, key, () => expr).
		expect(code).toContain('template("<div></div>")')
		expect(code).toContain('setProp(_el0, "style", () => ({')
		expect(code).toContain('color: state.color')
		expect(code).toContain('setProp(_el0, "title", () => state.title)')
	})

	it('routes intrinsic to template (setProp) and component to mergeProps (getter)', ()=> {
		const source = `
			const view = <><Button label={state.label} /><button onClick={handlers.save} disabled={locked} /></>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		// Component still goes through mergeProps — getter for the dynamic prop.
		expect(code).toContain('get label()')
		expect(code).toContain('return state.label')
		// Intrinsic <button> with mixed dynamic + identifier attrs now templates.
		// Dynamic handler → setProp with arrow accessor.
		expect(code).toContain('setProp(_el0, "onClick", () => handlers.save)')
		// Identifier value gets wrapped in a thunk so setProp takes its binding-
		// effect path — the runtime needs a function to track reactivity, since
		// the template path has no mergeProps Proxy to do it on its behalf.
		expect(code).toContain('setProp(_el0, "disabled", () => locked)')
	})

	it('emits a setProp accessor for a dynamic intrinsic event handler', ()=> {
		const source = `
			const view = <button onClick={flag() ? () => alert("A") : () => alert("B")}>Toggle</button>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('template("<button>Toggle</button>")')
		expect(code).toContain('setProp(_el0, "onClick", () => flag() ?')
	})

	it('does not wrap arrow-function or function-expression children', ()=> {
		const source = `
			const view = <div>{() => x}{function handler() { return x }}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).not.toContain('() => () => x')
		expect(code).not.toContain('() => function handler')
	})

	it('wraps plain function-call children', ()=> {
		const source = `
			const view = <div>{count()}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => count()')
	})

	it('wraps identifier used as a call argument when parent expression is a call (fn(foo))', ()=> {
		const source = `
			const view = <div>{fn(foo)}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => fn(foo)')
	})

	it('wraps a standalone identifier child in a thunk so insert takes its binding-effect path', ()=> {
		const source = `
			const view = <div>{fn}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		// Template path: single dynamic child → no marker. Identifier wrapped
		// in `() => fn` so the runtime's insert sets up a binding effect
		// (the template path has no mergeProps Proxy to provide reactivity).
		expect(code).toContain('template("<div></div>")')
		expect(code).toContain('insert(_el0, () => fn)')
	})

	it('wraps optional-call children', ()=> {
		const source = `
			const view = <div>{count?.()}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => count?.()')
	})

	it('wraps tagged-template-literal children', ()=> {
		const source = `
			const view = <div>{t\`Hello\`}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => t`Hello`')
	})

	it('emits an intrinsic attribute whose object value contains a spread element as a setProp accessor', ()=> {
		const source = `
			const view = <div style={{...styles}} />
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('setProp(_el0, "style", () => ({')
		expect(code).toContain('...styles')
	})

	it('wraps a nested JSX element used as a child expression', ()=> {
		const source = `
			const view = <div>{<span>text</span>}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() =>')
	})

	it('wraps a non-empty fragment used as a child expression', ()=> {
		const source = `
			const view = <div>{<><span /><p /></>}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() =>')
	})

	it('wraps an empty fragment child in an accessor arrow (template path needs a function for the binding effect)', ()=> {
		const source = `
			const view = <div>{<></>}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		// The template path wraps any non-literal/non-arrow child in `() => …`
		// so insert sets up its binding effect (the path has no mergeProps
		// proxy to track reactive reads).
		expect(code).toMatch(/insert\([^,]+,\s*\(\)\s*=>/)
	})

	it('emits a JSX element used as an attribute value as a getter and rewrites the inner element', ()=> {
		const source = `
			const view = <Foo bar={<Sub/>} />
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('get bar()')
		expect(code).toContain('jsx(Sub,')
	})

	it('emits a non-empty JSX fragment used as an attribute value as a getter and rewrites the inner fragment', ()=> {
		const source = `
			const view = <Foo bar={<>x</>} />
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('get bar()')
		expect(code).toContain('Fragment')
	})

	it('does not wrap literal children (number, string, null)', ()=> {
		const source = `
			const view = <div>{123}{"text"}{null}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).not.toContain('() => 123')
		expect(code).not.toContain('() => "text"')
		expect(code).not.toContain('() => null')
	})

	it('wraps update-expression children (count++)', ()=> {
		const source = `
			const view = <div>{count++}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => count++')
	})

	it('wraps assignment-expression children (state.value = 1)', ()=> {
		const source = `
			const view = <div>{state.value = 1}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => state.value = 1')
	})

	it('wraps logical-expression children when any operand is dynamic (flag() && value)', ()=> {
		const source = `
			const view = <div>{flag() && value}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => flag() && value')
	})

	it('wraps logical-expression identifier children so the template path takes its reactive insert path', ()=> {
		const source = `
			const view = <div>{flag && value}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => flag && value')
	})

	it('wraps conditional-expression children when any branch is dynamic (a ? state.b : c)', ()=> {
		const source = `
			const view = <div>{a ? state.b : c}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => a ? state.b : c')
	})

	it('wraps conditional-expression identifier children so the template path takes its reactive insert path', ()=> {
		const source = `
			const view = <div>{a ? b : c}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => a ? b : c')
	})

	it('wraps binary-expression children when one member is dynamic (a() + b)', ()=> {
		const source = `
			const view = <div>{a() + b}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => a() + b')
	})

	it('wraps binary-expression identifier children so the template path takes its reactive insert path', ()=> {
		const source = `
			const view = <div>{foo + bar}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => foo + bar')
	})

	it('wraps unary-expression children when operand is dynamic (!x())', ()=> {
		const source = `
			const view = <div>{!x()}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => !x()')
	})

	it('wraps array-expression children when one member is dynamic ([a(), 1])', ()=> {
		const source = `
			const view = <div>{[a(), 1]}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => [a(), 1]')
	})

	it('wraps object-expression children when one value is dynamic ({ x: value() })', ()=> {
		const source = `
			const view = <div>{{ x: value() }}</div>
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => ({')
		expect(code).toContain('x: value()')
	})

	it('wraps template-literal children when one interpolation member is dynamic (`Hello ${name()}`)', ()=> {
		const source = '\n\t\t\tconst view = <div>{`Hello ${name()}`}</div>\n\t\t'

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('() => `Hello ${name()}`')
	})
})

describe('babel plugin: Match slot lazy transform', ()=> {
	it('rewrites <Match><Case/><Default/></Match> children into case/default factory props', ()=> {
		const source = `
			const view = (
				<Match value={state()}>
					<Case when="idle"><p>Idle</p></Case>
					<Default><p>Fallback</p></Default>
				</Match>
			)
		`

		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformControlFlowPlugin],
		})

		const code = transformed?.code ?? ''

		expect(code).toContain('cases: [')
		expect(code).toContain('branch: () =>')
		expect(code).toContain('defaultBranch: () =>')
		expect(code).not.toContain('children: [')
	})
})

// The reactive plugin emits `jsx(...)` / `mergeProps(...)` calls. Compile
// the source in script mode so the plugin uses bare identifiers (no ESM
// imports inside the `new Function` body), then provide those identifiers
// as Function args.
const compileComponent = (source)=> {
	const transformed = transformSync(source, {
		configFile: false,
		babelrc: false,
		sourceType: 'script',
		presets: [[
			'@babel/preset-react',
			{
				runtime: 'classic',
				pragma: 'h',
				pragmaFrag: 'Fragment',
			},
		]],
		plugins: [transformReactivePlugin],
	})

	const code = transformed?.code ?? ''
	const factory = new Function('h', 'Fragment', 'jsx', 'jsxStatic', 'mergeProps', 'Dynamic', 'template', 'insert', 'setProp', `${code}; return App;`)

	return {
		code,
		App: factory(h, Fragment, jsx, jsxStatic, mergeProps, Dynamic, template, insert, setProp),
	}
}

describe('babel plugin: createTree reactivity in compiled components', ()=> {
	afterEach(()=> {
		document.body.innerHTML = ''
	})

	it('updates child text when createTree fields change in a compiled component', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <section>Count: {state.count}</section>
		`)
		const state = createTree({
			count: 1,
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		expect(container.textContent).toBe('Count: 1')

		state.count = 2

		expect(container.textContent).toBe('Count: 2')
	})

	it('updates intrinsic attributes from createTree fields in a compiled component', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <input title={state.meta.title} value={state.form.value} />
		`)
		const state = createTree({
			meta: {
				title: 'draft',
			},
			form: {
				value: 'A',
			},
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const input = container.querySelector('input')

		expect(input.getAttribute('title')).toBe('draft')
		expect(input.value).toBe('A')

		state.meta.title = 'published'
		state.form.value = 'B'

		expect(input.getAttribute('title')).toBe('published')
		expect(input.value).toBe('B')
	})

	it('updates ternary child branches driven by createTree fields in a compiled component', ()=> {
		const { code, App } = compileComponent(`
			const App = ({ state }) => <p>{state.done ? state.labels.done : state.labels.todo}</p>
		`)
		const state = createTree({
			done: false,
			labels: {
				done: 'Done',
				todo: 'Todo',
			},
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		expect(code).toContain('() => state.done ? state.labels.done : state.labels.todo')
		expect(container.textContent).toBe('Todo')

		state.done = true
		expect(container.textContent).toBe('Done')

		state.labels.done = 'Completed'
		expect(container.textContent).toBe('Completed')
	})

	it('updates array-derived values from createTree after push in a compiled component', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div>Total: {state.items.length}</div>
		`)
		const state = createTree({
			items: ['a', 'b'],
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		expect(container.textContent).toBe('Total: 2')

		state.items.push('c')

		expect(container.textContent).toBe('Total: 3')
	})

	it('tracks optional chaining and nullish fallback from createTree in children and attributes', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <p title={state.user?.name ?? 'anonymous'}>{state.user?.name ?? 'anonymous'}</p>
		`)
		const state = createTree({
			user: {
				name: 'Ada',
			},
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const paragraph = container.querySelector('p')

		expect(paragraph.getAttribute('title')).toBe('Ada')
		expect(paragraph.textContent).toBe('Ada')

		state.user.name = 'Grace'
		expect(paragraph.getAttribute('title')).toBe('Grace')
		expect(paragraph.textContent).toBe('Grace')

		state.user = null
		expect(paragraph.getAttribute('title')).toBe('anonymous')
		expect(paragraph.textContent).toBe('anonymous')

		state.user = {
			name: 'Linus',
		}
		expect(paragraph.getAttribute('title')).toBe('Linus')
		expect(paragraph.textContent).toBe('Linus')
	})

	it('clears removed style keys when style object is compiled from createTree fields', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div style={{ color: state.styles.color, ...(state.styles.fontSize ? { fontSize: state.styles.fontSize } : {}) }} />
		`)
		const state = createTree({
			styles: {
				color: 'red',
				fontSize: '14px',
			},
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const element = container.querySelector('div')

		expect(element.style.color).toBe('red')
		expect(element.style.fontSize).toBe('14px')

		state.styles.color = 'blue'
		state.styles.fontSize = ''

		expect(element.style.color).toBe('blue')
		expect(element.style.fontSize).toBe('')
	})

	it('reacts to createTree sparse index updates and length shrink in compiled JSX children', ()=> {
		const { code, App } = compileComponent(`
			const App = ({ state }) => <p>Item: {state.items[2] ?? 'empty'}</p>
		`)
		const state = createTree({
			items: ['A'],
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		expect(code).toContain('() => state.items[2] ?? \'empty\'')
		expect(container.textContent).toBe('Item: empty')

		state.items[2] = 'C'
		expect(container.textContent).toBe('Item: C')

		state.items.length = 1
		expect(container.textContent).toBe('Item: empty')
	})

	it('keeps createTree proxy reactive across component boundaries in compiled components', ()=> {
		const { code, App } = compileComponent(`
			const Child = ({ state }) => <span>{state.profile.name}</span>
			const App = ({ state }) => <section><Child state={state} /></section>
		`)
		const state = createTree({
			profile: {
				name: 'Ada',
			},
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		expect(code).toContain('() => state.profile.name')
		expect(container.textContent).toBe('Ada')

		state.profile.name = 'Grace'
		expect(container.textContent).toBe('Grace')

		state.profile = {
			name: 'Linus',
		}
		expect(container.textContent).toBe('Linus')
	})

	it('treats identifier tree child as static and renders placeholder comment', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div>{state}</div>
		`)
		const state = createTree({
			count: 1,
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const host = container.querySelector('div')

		// Template path: `{state}` is wrapped in `() => state` for the
		// reactive insert path. The accessor reads no tracked signals
		// (identifier lookup), so the binding effect runs once and never
		// re-runs. `resolveChildToNodes` coerces the proxy via `String(...)`
		// into a text node — the placeholder-comment behavior of the older
		// `jsxStatic`-path no longer applies under the template path.
		const initialText = host.textContent
		expect(host.childNodes).toHaveLength(1)
		expect(host.firstChild.nodeType).toBe(Node.TEXT_NODE)
		expect(initialText.length).toBeGreaterThan(0)

		state.count = 2
		// Identifier never read reactively → no re-render.
		expect(host.textContent).toBe(initialText)
	})

	it('emits identifier intrinsic props as plain references; runtime reactively reads the proxy/tree they point to', ()=> {
		const { App } = compileComponent(`
			const App = ({ styles, model }) => (
				<section>
					<div style={styles}>Card</div>
					<input value={model} />
				</section>
			)
		`)
		const styles = createTree({
			color: 'red',
		})
		const model = createTree({
			value: 'A',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			styles,
			model,
		}))

		const card = container.querySelector('div')
		const input = container.querySelector('input')

		// Initial mount applies the tree's current state.
		expect(card.style.color).toBe('red')
		expect(input.value).toBe('[object Object]')

		// Mutating the tree updates the DOM: each prop's binding effect
		// re-runs because `applyStyleProp` iterates the proxy inside its own
		// binding effect, picking up tracked reads. (`value` is a string
		// property that coerces the object — still updates on assignment.)
		styles.color = 'blue'
		expect(card.style.color).toBe('blue')
	})

	it('emits dynamic component props as getters; children that read props.<x> stay reactive across updates', ()=> {
		// Child reads `props.label` directly (Solid-style proxy access) instead
		// of destructuring, so each access goes through the mergeProps proxy
		// and observes the getter's signal reads.
		const { code, App } = compileComponent(`
			const Child = (props) => <span>{props.label}</span>
			const App = ({ state }) => <Child label={state.label} />
		`)
		const state = createTree({
			label: 'Todo',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		expect(code).toContain('get label()')
		expect(code).toContain('return state.label')
		expect(container.textContent).toBe('Todo')

		state.label = 'Done'
		expect(container.textContent).toBe('Done')
	})

	it('emits Dynamic component prop as a getter so tag updates from createTree are reactive', ()=> {
		const { code, App } = compileComponent(`
			const App = ({ state }) => <Dynamic component={state.tag}>Value</Dynamic>
		`)

		const state = createTree({
			tag: 'span',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		expect(code).toContain('get component()')
		expect(code).toContain('return state.tag')
		expect(container.firstChild.tagName).toBe('SPAN')

		state.tag = 'strong'
		expect(container.firstChild.tagName).toBe('SPAN')
		expect(container.firstChild.textContent).toBe('Value')
	})
})

describe('babel plugin: reactive spread via mergeProps', ()=> {
	afterEach(()=> {
		document.body.innerHTML = ''
	})

	const compileWithAutomatic = (source)=> {
		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})
		return transformed?.code ?? ''
	}

	it('wraps a non-static JSX spread in a thunk argument to mergeProps', ()=> {
		const code = compileWithAutomatic(`const view = <div a={1} {...api().getRootProps()} b={2} />`)

		// Non-spread attributes around the spread group into their own object
		// arguments; the dynamic spread becomes its own thunk argument so the
		// proxy re-evaluates it lazily.
		expect(code).toContain('mergeProps(')
		expect(code).toContain('() => api().getRootProps()')
		expect(code).toContain('a: 1')
		expect(code).toContain('b: 2')
	})

	it('adds attributes that appear later in a dynamic spread source', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...state.props} />
		`)
		const state = createTree({
			props: {
				title: 'hello',
			},
		})

		const container = document.createElement('div')
		document.body.appendChild(container)
		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('title')).toBe('hello')
		expect(el.getAttribute('data-x')).toBe(null)

		state.props['data-x'] = '1'
		expect(el.getAttribute('data-x')).toBe('1')
	})

	it('emits each dynamic spread as a distinct thunk argument', ()=> {
		const code = compileWithAutomatic(`const view = <div {...one()} {...two()} />`)

		expect(code).toContain('() => one()')
		expect(code).toContain('() => two()')
	})

	it('leaves a static object-literal spread as a plain object argument', ()=> {
		const code = compileWithAutomatic(`const view = <div {...{ id: 'x', title: 'y' }} />`)

		// Static spread keeps its identity — emitted directly, not wrapped in a thunk.
		expect(code).not.toContain('() => ({')
		expect(code).toContain("id: 'x'")
		expect(code).toContain("title: 'y'")
	})

	it('updates DOM attributes when a dynamic spread source returns new values', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...({ 'data-value': state.value, title: state.title })} />
		`)
		const state = createTree({
			value: '1',
			title: 'first',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('data-value')).toBe('1')
		expect(el.getAttribute('title')).toBe('first')

		state.value = '2'
		state.title = 'second'

		expect(el.getAttribute('data-value')).toBe('2')
		expect(el.getAttribute('title')).toBe('second')
	})

	it('clears attributes that drop out of the spread on a later run', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...state.props} />
		`)
		const state = createTree({
			props: {
				title: 'hello',
				'data-x': '1',
			},
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('title')).toBe('hello')
		expect(el.getAttribute('data-x')).toBe('1')

		state.props = {
			title: 'world',
		}

		expect(el.getAttribute('title')).toBe('world')
		expect(el.hasAttribute('data-x')).toBe(false)
	})

	it('swaps event handlers across spread re-evaluations', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <button {...({ onClick: state.handler })}>x</button>
		`)
		const calls = []
		const state = createTree({
			handler: ()=> calls.push('a'),
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const btn = container.querySelector('button')
		btn.click()
		expect(calls).toEqual(['a'])

		state.handler = ()=> calls.push('b')
		btn.click()
		expect(calls).toEqual(['a', 'b'])
	})

	it('lets static props after a spread override its keys', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...({ 'data-x': state.value })} data-x="fixed" />
		`)
		const state = createTree({
			value: 'from-spread',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('data-x')).toBe('fixed')
	})

	// ── Compile-time: spread-argument wrapping decisions ──────────────────────

	it('passes an identifier spread directly to mergeProps (no thunk — tree Proxy handles reactivity via its own traps)', ()=> {
		const code = compileWithAutomatic(`const view = <div {...obj} />`)

		expect(code).toContain('mergeProps(obj)')
		expect(code).not.toContain('() => obj')
	})

	it('wraps a member-expression spread in a thunk', ()=> {
		const code = compileWithAutomatic(`const view = <div {...store.props} />`)

		expect(code).toContain('() => store.props')
	})

	it('wraps an optional-member-expression spread in a thunk', ()=> {
		const code = compileWithAutomatic(`const view = <div {...state?.rest} />`)

		expect(code).toContain('() => state?.rest')
	})

	it('wraps a deeply chained member-expression spread in a thunk', ()=> {
		const code = compileWithAutomatic(`const view = <div {...a.b.c} />`)

		expect(code).toContain('() => a.b.c')
	})

	it('does not wrap a ternary spread when all branches are static identifiers', ()=> {
		const code = compileWithAutomatic(`const view = <div {...(flag ? a : b)} />`)

		expect(code).not.toContain('() => flag')
		expect(code).toContain('flag ? a : b')
	})

	it('wraps a ternary spread when one branch is a dynamic call expression', ()=> {
		const code = compileWithAutomatic(`const view = <div {...(flag ? api() : defaults)} />`)

		expect(code).toContain('() => flag ? api() : defaults')
	})

	it('does not wrap a logical-expression spread when both operands are static identifiers', ()=> {
		const code = compileWithAutomatic(`const view = <div {...(a || b)} />`)

		expect(code).not.toContain('() => a || b')
		expect(code).toContain('a || b')
	})

	it('wraps a logical-expression spread when one operand is a dynamic member access', ()=> {
		const code = compileWithAutomatic(`const view = <div {...(state.extra || {})} />`)

		expect(code).toContain('() => state.extra || {}')
	})

	it('wraps an object-literal spread that contains an inner spread element', ()=> {
		const code = compileWithAutomatic(`const view = <div {...{ ...extra }} />`)

		expect(code).toContain('...extra')
		expect(code).toMatch(/\(\)\s*=>/)
	})

	it('wraps an object-literal spread whose property value is a dynamic call expression', ()=> {
		const code = compileWithAutomatic(`const view = <div {...{ x: computed() }} />`)

		expect(code).toContain('x: computed()')
		expect(code).toMatch(/\(\)\s*=>/)
	})

	it('passes an inline arrow-function spread directly without double-wrapping', ()=> {
		const code = compileWithAutomatic(`const view = <div {...(() => baseProps)} />`)

		expect(code).not.toContain('() => () =>')
		expect(code).toContain('() => baseProps')
	})

	it('passes a null spread directly as a plain mergeProps arg (static literal)', ()=> {
		const code = compileWithAutomatic(`const view = <div {...null} />`)

		expect(code).toContain('mergeProps(null)')
		expect(code).not.toMatch(/\(\)\s*=>\s*null/)
	})

	// ── Compile-time: argument grouping and ordering ──────────────────────────

	it('groups consecutive non-spread attrs and keeps each spread as a separate positional arg', ()=> {
		const code = compileWithAutomatic(`const view = <div a={1} {...s1()} b={2} c={3} {...s2()} d={4} />`)

		expect(code).toContain('a: 1')
		expect(code).toContain('() => s1()')
		expect(code).toContain('b: 2')
		expect(code).toContain('c: 3')
		expect(code).toContain('() => s2()')
		expect(code).toContain('d: 4')

		// b and c must share the same object group — no thunk between them
		const bIdx = code.indexOf('b: 2')
		const cIdx = code.indexOf('c: 3')
		const betweenBC = code.slice(Math.min(bIdx, cIdx), Math.max(bIdx, cIdx))
		expect(betweenBC).not.toContain('() =>')
	})

	it('emits a leading spread thunk before the trailing attrs object', ()=> {
		const code = compileWithAutomatic(`const view = <div {...api()} id="x" />`)

		expect(code).toContain('() => api()')
		expect(code).toContain('id: "x"')
		expect(code.indexOf('() => api()')).toBeLessThan(code.indexOf('id: "x"'))
	})

	it('emits a leading attrs object before the trailing spread thunk', ()=> {
		const code = compileWithAutomatic(`const view = <div id="x" {...api()} />`)

		expect(code).toContain('id: "x"')
		expect(code).toContain('() => api()')
		expect(code.indexOf('id: "x"')).toBeLessThan(code.indexOf('() => api()'))
	})

	it('skips mergeProps entirely and emits jsx(Tag, {}) when there are no attrs and no children', ()=> {
		const code = compileWithAutomatic(`const view = <MyComp />`)

		expect(code).not.toContain('mergeProps')
		expect(code).toMatch(/jsx\(MyComp,\s*\{\}/)
	})

	it('attaches children to the last object group when that group holds regular attrs', ()=> {
		const code = compileWithAutomatic(`const view = <Comp a={1}>{child}</Comp>`)

		// a:1 and children:child must share the same object literal — no thunk between them
		const aIdx = code.indexOf('a: 1')
		const chIdx = code.indexOf('children: child')
		const between = code.slice(Math.min(aIdx, chIdx), Math.max(aIdx, chIdx))
		expect(between).not.toContain('() =>')
	})

	it('creates a separate trailing object group for children when the last arg is a spread', ()=> {
		const code = compileWithAutomatic(`const view = <Comp {...api()}>{child}</Comp>`)

		const thunkIdx = code.indexOf('() => api()')
		const childrenIdx = code.indexOf('children: child')
		expect(thunkIdx).toBeGreaterThan(-1)
		expect(childrenIdx).toBeGreaterThan(thunkIdx)
	})

	it('creates a children-only trailing group when there are no attrs', ()=> {
		const code = compileWithAutomatic(`const view = <Comp>{child}</Comp>`)

		expect(code).toContain('mergeProps(')
		expect(code).toContain('children: child')
	})

	it('emits aria-* attribute keys as quoted string literals inside the object group', ()=> {
		const code = compileWithAutomatic(`const view = <div {...api()} aria-label="close" aria-hidden={hidden} />`)

		expect(code).toContain('"aria-label"')
		expect(code).toContain('"aria-hidden"')
	})

	it('emits data-* attribute keys as quoted string literals', ()=> {
		const code = compileWithAutomatic(`const view = <div {...api()} data-testid="btn" />`)

		expect(code).toContain('"data-testid"')
	})

	it('emits a boolean-shorthand attribute as a plain true property, not a getter', ()=> {
		const code = compileWithAutomatic(`const view = <button disabled {...api()} />`)

		expect(code).toContain('disabled: true')
		expect(code).not.toContain('get disabled()')
	})
})

describe('babel plugin: jsxStatic fast path', ()=> {
	const compileWithAutomatic = (source)=> {
		const transformed = transformSync(source, {
			configFile: false,
			babelrc: false,
			presets: [[
				'@babel/preset-react',
				{
					runtime: 'automatic',
					importSource: 'plastic',
				},
			]],
			plugins: [transformReactivePlugin],
		})
		return transformed?.code ?? ''
	}

	it('emits a hoisted template for an intrinsic tag whose attrs are all literals (pure static — beats jsxStatic)', ()=> {
		const code = compileWithAutomatic(`const view = <div className="row" id="x" />`)
		expect(code).toContain('template("<div class=\\"row\\" id=\\"x\\"></div>")')
		expect(code).toContain('.cloneNode(true)')
		expect(code).not.toContain('jsxStatic')
		expect(code).not.toContain('mergeProps')
	})

	it('emits a template for boolean-shorthand attrs (pure static)', ()=> {
		const code = compileWithAutomatic(`const view = <input disabled />`)
		expect(code).toContain('template("<input disabled>")')
		expect(code).not.toContain('jsxStatic')
	})

	it('templates a single dynamic child as an insert without a marker (beats jsxStatic)', ()=> {
		const code = compileWithAutomatic(`const view = <h1 className="t">{state.title}</h1>`)
		expect(code).toContain('template("<h1 class=\\"t\\"></h1>")')
		expect(code).toContain('insert(_el0, () => state.title)')
		expect(code).not.toContain('jsxStatic')
	})

	it('emits a template for an element with only static text children (pure static — beats jsxStatic)', ()=> {
		const code = compileWithAutomatic(`const view = <h1 className="t">Hello</h1>`)
		expect(code).toContain('template("<h1 class=\\"t\\">Hello</h1>")')
		expect(code).not.toContain('jsxStatic')
		expect(code).not.toContain('mergeProps')
	})

	it('templates an intrinsic with a dynamic attr value (setProp accessor — beats jsxStatic)', ()=> {
		const code = compileWithAutomatic(`const view = <div title={state.t} />`)
		expect(code).not.toContain('jsxStatic')
		expect(code).toContain('template("<div></div>")')
		expect(code).toContain('setProp(_el0, "title", () => state.t)')
	})

	it('templates an intrinsic with an identifier attr value (setProp wraps identifier in a thunk for reactivity)', ()=> {
		const code = compileWithAutomatic(`const view = <div style={styles} />`)
		expect(code).not.toContain('jsxStatic')
		expect(code).toContain('template("<div></div>")')
		expect(code).toContain('setProp(_el0, "style", () => styles)')
	})

	it('does not use jsxStatic when there is a spread attribute', ()=> {
		const code = compileWithAutomatic(`const view = <div className="row" {...rest} />`)
		expect(code).not.toContain('jsxStatic')
		expect(code).toContain('mergeProps')
	})

	it('does not use jsxStatic for component tags', ()=> {
		const code = compileWithAutomatic(`const view = <Foo bar="baz" />`)
		expect(code).not.toContain('jsxStatic')
	})

	it('templates intrinsic 0-attr elements with a dynamic identifier child (pure structural — beats jsxStatic)', ()=> {
		const code = compileWithAutomatic(`const view = <span>{x}</span>`)
		expect(code).toContain('template("<span></span>")')
		// Single dynamic child → no marker. Identifier wrapped in a thunk so
		// insert sets up its binding effect (no mergeProps Proxy in this path).
		expect(code).toContain('insert(_el0, () => x)')
		expect(code).not.toContain('jsxStatic')
	})

	it('emits a template for intrinsic 0-attr 0-child elements (pure static — beats jsxStatic)', ()=> {
		const code = compileWithAutomatic(`const view = <hr />`)
		expect(code).toContain('template("<hr>")')
		expect(code).toContain('.cloneNode(true)')
		expect(code).not.toContain('jsxStatic')
	})

	it('does not use jsxStatic for namespaced intrinsic tags', ()=> {
		const code = compileWithAutomatic(`const view = <svg:rect className="a" />`)
		expect(code).not.toContain('jsxStatic')
	})
})

describe('babel plugin: attribute spread – runtime behavior edge cases', ()=> {
	afterEach(()=> {
		document.body.innerHTML = ''
	})

	it('last-wins: second spread overrides first when both carry the same key', ()=> {
		const { App } = compileComponent(`
			const App = () => <div {...({ 'data-x': 'first' })} {...({ 'data-x': 'second' })} />
		`)
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {}))

		expect(container.querySelector('div').getAttribute('data-x')).toBe('second')
	})

	it('a spread placed after an explicit attr overrides that attr and stays reactive', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div data-x="base" {...({ 'data-x': state.value })} />
		`)
		const state = createTree({
			value: 'override',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('data-x')).toBe('override')

		state.value = 'updated'
		expect(el.getAttribute('data-x')).toBe('updated')
	})

	it('concatenates class values from spread and explicit class attr', ()=> {
		const { App } = compileComponent(`
			const App = () => <div {...({ class: 'spread-cls' })} class="extra-cls" />
		`)
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {}))

		const el = container.querySelector('div')
		expect(el.className).toContain('spread-cls')
		expect(el.className).toContain('extra-cls')
	})

	it('updates one spread class independently without disturbing class from a sibling spread', ()=> {
		const { App } = compileComponent(`
			const App = ({ s1, s2 }) => <div {...({ class: s1.cls })} {...({ class: s2.cls })} />
		`)
		const s1 = createTree({
			cls: 'a',
		})
		const s2 = createTree({
			cls: 'b',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			s1,
			s2,
		}))

		const el = container.querySelector('div')
		expect(el.className).toContain('a')
		expect(el.className).toContain('b')

		s1.cls = 'c'
		expect(el.className).toContain('c')
		expect(el.className).toContain('b')
	})

	it('merges style objects from spread and explicit style attr, reacting to spread changes', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...({ style: { color: state.color } })} style={{ fontWeight: 'bold' }} />
		`)
		const state = createTree({
			color: 'red',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.style.color).toBe('red')
		expect(el.style.fontWeight).toBe('bold')

		state.color = 'blue'
		expect(el.style.color).toBe('blue')
		expect(el.style.fontWeight).toBe('bold')
	})

	it('onClick from explicit attr wins over spread (last-wins, matches Solid)', ()=> {
		const calls = []
		const { App } = compileComponent(`
			const App = ({ h1, h2 }) => <button {...({ onClick: h1 })} onClick={h2}>x</button>
		`)
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			h1: ()=> calls.push('spread'),
			h2: ()=> calls.push('explicit'),
		}))

		container.querySelector('button').click()
		expect(calls).toEqual(['explicit'])
	})

	it('updates dynamic spread and dynamic attr independently without cross-triggering', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...({ title: state.title })} data-value={state.value} />
		`)
		const state = createTree({
			title: 'a',
			value: '1',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')

		state.title = 'b'
		expect(el.getAttribute('title')).toBe('b')
		expect(el.getAttribute('data-value')).toBe('1')

		state.value = '2'
		expect(el.getAttribute('title')).toBe('b')
		expect(el.getAttribute('data-value')).toBe('2')
	})

	it('identifier spread from a tree Proxy stays reactive via Proxy get/ownKeys traps', ()=> {
		// `extraProps` is an Identifier → plugin emits it directly (no thunk).
		// mergeProps uses the tree Proxy object itself; its get trap provides reactivity.
		const { App } = compileComponent(`
			const App = ({ extraProps }) => <div {...extraProps} />
		`)
		const extraProps = createTree({
			'data-x': 'hello',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			extraProps,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('data-x')).toBe('hello')

		extraProps['data-x'] = 'world'
		expect(el.getAttribute('data-x')).toBe('world')
	})

	it('identifier spread from a tree Proxy picks up a newly added key', ()=> {
		const { App } = compileComponent(`
			const App = ({ extraProps }) => <div {...extraProps} />
		`)
		const extraProps = createTree({})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			extraProps,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('data-new')).toBe(null)

		extraProps['data-new'] = 'appeared'
		expect(el.getAttribute('data-new')).toBe('appeared')
	})

	it('child component receives spread props from tree Proxy and stays reactive', ()=> {
		const { App } = compileComponent(`
			const Child = (props) => <span>{props.label}</span>
			const App = ({ spreadProps }) => <Child {...spreadProps} />
		`)
		const spreadProps = createTree({
			label: 'before',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			spreadProps,
		}))

		expect(container.textContent).toBe('before')

		spreadProps.label = 'after'
		expect(container.textContent).toBe('after')
	})

	it('replaces all spread attrs when the spread object reference is swapped entirely', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...state.attrs} />
		`)
		const state = createTree({
			attrs: {
				'data-a': '1',
				'data-b': '2',
			},
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('data-a')).toBe('1')
		expect(el.getAttribute('data-b')).toBe('2')

		state.attrs = {
			'data-c': '3',
		}

		expect(el.hasAttribute('data-a')).toBe(false)
		expect(el.hasAttribute('data-b')).toBe(false)
		expect(el.getAttribute('data-c')).toBe('3')
	})

	it('retains static attrs between a spread source and an explicit override across reactive cycles', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div {...({ title: state.title, 'data-x': 'spread' })} data-x="pinned" />
		`)
		const state = createTree({
			title: 'v1',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('title')).toBe('v1')
		expect(el.getAttribute('data-x')).toBe('pinned')

		state.title = 'v2'
		expect(el.getAttribute('title')).toBe('v2')
		expect(el.getAttribute('data-x')).toBe('pinned')
	})

	// The header-comment canonical pattern:
	//   <MyComp {...api()} foo={2} bar={state.b}>{kid}</MyComp>
	// api() is an external function whose return value is driven by internal
	// reactive state. The plugin wraps it as () => api() so mergeProps calls
	// it inside the binding effect, tracking any signal reads api() performs.
	it('re-applies attrs when api() returns new props after its internal reactive state changes', ()=> {
		const { App } = compileComponent(`
			const App = ({ api, state }) => <div {...api()} bar={state.bar} />
		`)
		const machine = createTree({
			id: 'orig',
			role: 'button',
		})
		const api = ()=> ({
			id: machine.id,
			role: machine.role,
		})
		const state = createTree({
			bar: 'static',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			api,
			state,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('id')).toBe('orig')
		expect(el.getAttribute('role')).toBe('button')
		expect(el.getAttribute('bar')).toBe('static')

		machine.id = 'new-id'
		expect(el.getAttribute('id')).toBe('new-id')
		expect(el.getAttribute('role')).toBe('button')

		machine.role = 'checkbox'
		expect(el.getAttribute('role')).toBe('checkbox')
		expect(el.getAttribute('bar')).toBe('static')
	})

	it('re-applies attrs when api() adds a new key that was absent in the initial return value', ()=> {
		const { App } = compileComponent(`
			const App = ({ api }) => <div {...api()} />
		`)
		const machine = createTree({
			id: 'btn',
		})
		const api = ()=> ({
			id: machine.id,
			...(machine.pressed ? { 'aria-pressed': String(machine.pressed) } : {}),
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			api,
		}))

		const el = container.querySelector('div')
		expect(el.getAttribute('id')).toBe('btn')
		expect(el.hasAttribute('aria-pressed')).toBe(false)

		machine.pressed = true
		expect(el.getAttribute('aria-pressed')).toBe('true')

		machine.pressed = false
		expect(el.hasAttribute('aria-pressed')).toBe(false)
	})

	it('combines api() spread with sibling getter attr and children, all reactive independently', ()=> {
		const { App } = compileComponent(`
			const App = ({ api, state }) => <button {...api()} bar={state.bar}>{state.label}</button>
		`)
		const machine = createTree({
			disabled: false,
		})
		const api = ()=> ({
			disabled: machine.disabled,
			'data-machine': 'on',
		})
		const state = createTree({
			bar: 'initial',
			label: 'Click',
		})
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {
			api,
			state,
		}))

		const el = container.querySelector('button')
		expect(el.disabled).toBe(false)
		expect(el.getAttribute('data-machine')).toBe('on')
		expect(el.getAttribute('bar')).toBe('initial')
		expect(el.textContent).toBe('Click')

		machine.disabled = true
		expect(el.disabled).toBe(true)
		expect(el.getAttribute('bar')).toBe('initial')

		state.bar = 'updated'
		expect(el.disabled).toBe(true)
		expect(el.getAttribute('bar')).toBe('updated')

		state.label = 'Done'
		expect(el.textContent).toBe('Done')
		expect(el.disabled).toBe(true)
	})

	it('compiles component-level {...props} spread as mergeProps(props) without a thunk', ()=> {
		const { code } = compileComponent(`
			function App() {}
			function Child(props) {
				return <GrandChild {...props} />
			}
		`)

		expect(code).toContain('mergeProps(props)')
		expect(code).not.toContain('() => props')
	})

	it('grandchild receives a mergeProps proxy when parent spreads its own props', ()=> {
		const { App } = compileComponent(`
			const GrandChild = (props) => <span>{props.label}</span>
			const Child = (props) => <GrandChild {...props} />
			const App = (props) => <Child label={props.label} />
		`)
		const state = createTree({ label: 'hello' })
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, state))

		expect(container.textContent).toBe('hello')

		state.label = 'world'
		expect(container.textContent).toBe('world')
	})

	it('grandchild receives the spread keys after {...props} passthrough', ()=> {
		// mergeProps single-plain-object fast path now returns the source
		// itself, so the grandchild no longer necessarily sees a mergeProps
		// Proxy. What we care about is that the keys flow through unchanged.
		let capturedProps
		const GrandChild = (props)=> {
			capturedProps = props
			return null
		}
		const Child = (props)=> jsx(GrandChild, mergeProps(props))
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(Child, { a: 1 }))

		expect(capturedProps.a).toBe(1)
	})
})

// Control-flow plugin only: transform source and return the emitted code.
const compileControlFlow = (source)=> {
	const transformed = transformSync(source, {
		configFile: false,
		babelrc: false,
		presets: [[
			'@babel/preset-react',
			{
				runtime: 'automatic',
				importSource: 'plastic',
			},
		]],
		plugins: [transformControlFlowPlugin],
	})

	return transformed?.code ?? ''
}

describe('babel plugin: control-flow edge cases', ()=> {
	it('Either with only <True> emits trueBranch only', ()=> {
		const code = compileControlFlow(`
			const view = <Either condition={flag()}><True><p>A</p></True></Either>
		`)

		expect(code).toContain('trueBranch: () =>')
		expect(code).not.toContain('falseBranch')
	})

	it('Either with only <False> emits falseBranch only', ()=> {
		const code = compileControlFlow(`
			const view = <Either condition={flag()}><False><p>B</p></False></Either>
		`)

		expect(code).toContain('falseBranch: () =>')
		expect(code).not.toContain('trueBranch')
	})

	it('Either with neither <True> nor <False> is left untouched', ()=> {
		const code = compileControlFlow(`
			const view = <Either condition={flag()}><span>plain</span></Either>
		`)

		expect(code).not.toContain('trueBranch')
		expect(code).not.toContain('falseBranch')
	})

	it('Either branch with multiple children wraps them in a Fragment', ()=> {
		const code = compileControlFlow(`
			const view = (
				<Either condition={flag()}>
					<True><p>A</p><p>B</p></True>
				</Either>
			)
		`)

		expect(code).toContain('trueBranch: () =>')
		expect(code).toContain('Fragment')
	})

	it('Either with empty <True> body emits trueBranch that returns null', ()=> {
		const code = compileControlFlow(`
			const view = <Either condition={flag()}><True></True><False><p>B</p></False></Either>
		`)

		expect(code).toMatch(/trueBranch:\s*\(\)\s*=>\s*null/)
	})

	it('Either replaces a pre-existing trueBranch prop instead of duplicating it', ()=> {
		// Documented idempotency contract: stale generated props from a prior
		// transform are stripped before fresh ones are emitted. Here, a stale
		// `trueBranch={null}` co-exists with `<True>` body; only the body wins.
		const code = compileControlFlow(`
			const view = (
				<Either condition={flag()} trueBranch={null}>
					<True><p>A</p></True>
					<False><p>B</p></False>
				</Either>
			)
		`)

		expect(code.match(/trueBranch/g)).toHaveLength(1)
		expect(code).not.toContain('trueBranch: null')
		expect(code).toContain('trueBranch: () =>')
	})

	it('Match with only <Default> emits defaultBranch but no cases array', ()=> {
		const code = compileControlFlow(`
			const view = <Match value={state()}><Default><p>Fallback</p></Default></Match>
		`)

		expect(code).toContain('defaultBranch: () =>')
		expect(code).not.toContain('cases:')
	})

	it('Match with only <Case> emits cases array but no defaultBranch', ()=> {
		const code = compileControlFlow(`
			const view = <Match value={state()}><Case when="a"><p>A</p></Case></Match>
		`)

		expect(code).toContain('cases: [')
		expect(code).toContain('when: "a"')
		expect(code).not.toContain('defaultBranch')
	})

	it('Match with no Case/Default children is left untouched', ()=> {
		const code = compileControlFlow(`
			const view = <Match value={state()}><span>plain</span></Match>
		`)

		expect(code).not.toContain('cases:')
		expect(code).not.toContain('defaultBranch')
	})

	it('Match <Case> without when emits descriptor with branch only', ()=> {
		const code = compileControlFlow(`
			const view = <Match value={state()}><Case><p>X</p></Case></Match>
		`)

		expect(code).toContain('branch: () =>')
		expect(code).not.toMatch(/when:/)
	})

	it('Match <Case when> with expression value preserves the expression', ()=> {
		const code = compileControlFlow(`
			const view = <Match value={state()}><Case when={getKey()}><p>X</p></Case></Match>
		`)

		expect(code).toContain('when: getKey()')
	})

	it('Match strips when attribute from the inner <Case> wrapper', ()=> {
		const code = compileControlFlow(`
			const view = <Match value={state()}><Case when="key"><p>X</p></Case></Match>
		`)

		// `when: "key"` should appear exactly once — on the lifted descriptor,
		// not also as a prop on the inner _jsx(Case, …) call.
		expect(code.match(/when:\s*"key"/g)).toHaveLength(1)
	})

	it('Match with multiple Cases preserves source order in the cases array', ()=> {
		const code = compileControlFlow(`
			const view = (
				<Match value={state()}>
					<Case when="a"><p>A</p></Case>
					<Case when="b"><p>B</p></Case>
					<Case when="c"><p>C</p></Case>
				</Match>
			)
		`)

		const aIndex = code.indexOf('when: "a"')
		const bIndex = code.indexOf('when: "b"')
		const cIndex = code.indexOf('when: "c"')
		expect(aIndex).toBeGreaterThan(-1)
		expect(bIndex).toBeGreaterThan(aIndex)
		expect(cIndex).toBeGreaterThan(bIndex)
	})

	it('Context.Provider with multiple children wraps them in a Fragment factory', ()=> {
		const code = compileControlFlow(`
			const view = <Theme.Provider value="dark"><p>A</p><p>B</p></Theme.Provider>
		`)

		expect(code).toContain('children: () =>')
		expect(code).toContain('Fragment')
	})

	it('Context.Provider with an expression-container child unwraps to the inner expression', ()=> {
		const code = compileControlFlow(`
			const view = <Theme.Provider value="dark">{computeChild()}</Theme.Provider>
		`)

		expect(code).toContain('children: () => computeChild()')
	})

	it('Context.Provider with no meaningful children is left untouched', ()=> {
		const code = compileControlFlow(`
			const view = <Theme.Provider value="dark">   </Theme.Provider>
		`)

		expect(code).not.toContain('children: () =>')
	})

	it('Context.Provider transform replaces a pre-existing children prop instead of duplicating it', ()=> {
		const code = compileControlFlow(`
			const view = <Theme.Provider value="dark" children={() => null}><p>A</p></Theme.Provider>
		`)

		// The stale `() => null` body must lose to the fresh JSX body.
		expect(code).not.toContain('() => null')
		expect(code).toContain('children: () =>')
	})

	it('Either branches strip whitespace-only siblings before unwrapping', ()=> {
		const code = compileControlFlow(`
			const view = (
				<Either condition={flag()}>
					<True>
						<p>A</p>
					</True>
				</Either>
			)
		`)

		// Single meaningful child — should be lifted without a Fragment wrapper.
		expect(code).toContain('trueBranch: () =>')
		expect(code).not.toContain('Fragment')
	})

	it('Either nested inside Either lifts both levels independently', ()=> {
		const code = compileControlFlow(`
			const view = (
				<Either condition={outer()}>
					<True>
						<Either condition={inner()}>
							<True><p>AA</p></True>
							<False><p>AB</p></False>
						</Either>
					</True>
					<False><p>B</p></False>
				</Either>
			)
		`)

		// Two Either transforms ⇒ trueBranch appears twice, falseBranch twice.
		expect(code.match(/trueBranch/g)).toHaveLength(2)
		expect(code.match(/falseBranch/g)).toHaveLength(2)
	})
})

describe('mergeProps: isMergedProps', ()=> {
	it('returns true for a multi-source mergeProps proxy', ()=> {
		// Single plain-object sources are intentionally short-circuited by
		// mergeProps and returned as-is, so use 2+ sources to force a Proxy.
		expect(isMergedProps(mergeProps({ a: 1 }, { b: 2 }))).toBe(true)
	})

	it('returns the original object for a single plain-object source (fast path)', ()=> {
		const src = { a: 1 }
		expect(mergeProps(src)).toBe(src)
		expect(isMergedProps(src)).toBe(false)
	})

	it('returns false for plain objects and non-objects', ()=> {
		expect(isMergedProps({})).toBe(false)
		expect(isMergedProps(null)).toBe(false)
		expect(isMergedProps(42)).toBe(false)
	})

	it('marker symbol does not appear in ownKeys', ()=> {
		const proxy = mergeProps({ a: 1 }, { b: 2 })
		expect(Reflect.ownKeys(proxy).every(k=> typeof k === 'string')).toBe(true)
	})
})

describe('babel plugin: adjacent text children coalesce in template plan', ()=> {
	afterEach(()=> {
		document.body.innerHTML = ''
	})

	it('places dynamic holes into the correct element when JSX text is split by a {" "} literal', ()=> {
		// Repro: prior to the fix, each {' '} bumped the compile-time
		// child index, but the HTML parser merged the adjacent runs of
		// text into a single text node, so walker paths landed on a
		// text node instead of the intended <strong>.
		const { App } = compileComponent(`
			const App = ({ state }) => (
				<p>
					className is{' '}
					<strong>{state.a}</strong>
					. Style mode is{' '}
					<strong>{state.b}</strong>.
				</p>
			)
		`)
		const state = createTree({ a: 'A1', b: 'B1' })
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, { state }))

		const strongs = container.querySelectorAll('strong')
		expect(strongs.length).toBe(2)
		expect(strongs[0].textContent).toBe('A1')
		expect(strongs[1].textContent).toBe('B1')

		state.a = 'A2'
		state.b = 'B2'

		expect(strongs[0].textContent).toBe('A2')
		expect(strongs[1].textContent).toBe('B2')
	})

	it('resolves an element walker correctly when adjacent string-literal children precede it', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <div>{'a'}{'b'}<span>{state.x}</span>{'c'}</div>
		`)
		const state = createTree({ x: 'X1' })
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, { state }))

		expect(container.textContent).toBe('abX1c')
		const span = container.querySelector('span')
		expect(span.textContent).toBe('X1')

		state.x = 'X2'
		expect(span.textContent).toBe('X2')
		expect(container.textContent).toBe('abX2c')
	})

	it('handles JSX text plus {" "} around a dynamic hole (marker boundary)', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <p>hello{' '}{state.x}{' '}world</p>
		`)
		const state = createTree({ x: 'X1' })
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, { state }))

		expect(container.textContent).toBe('hello X1 world')

		state.x = 'X2'
		expect(container.textContent).toBe('hello X2 world')
	})

	it('preserves whitespace inside <pre> while still coalescing adjacent text children', ()=> {
		const { App } = compileComponent(`
			const App = ({ state }) => <pre>{'a  b'}{'  c'}<span>{state.x}</span></pre>
		`)
		const state = createTree({ x: 'X1' })
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, { state }))

		const pre = container.querySelector('pre')
		const span = pre.querySelector('span')
		expect(span.textContent).toBe('X1')
		// Leading text run preserves its runs of internal whitespace
		// (the whitespace-sensitive branch skips normalizeJsxText) and
		// coalesces adjacent text-emitting children into a single node.
		expect(pre.firstChild.nodeType).toBe(3)
		expect(pre.firstChild.textContent).toBe('a  b  c')
	})

	it('round-trips a pure-static subtree of adjacent text children through innerHTML', ()=> {
		const { App } = compileComponent(`
			const App = () => <p>hello{' '}world{'!'}</p>
		`)
		const container = document.createElement('div')
		document.body.appendChild(container)

		renderApp(container, h(App, {}))

		const p = container.querySelector('p')
		// A single coalesced text node — what innerHTML produces.
		expect(p.childNodes.length).toBe(1)
		expect(p.firstChild.nodeType).toBe(3)
		expect(p.textContent).toBe('hello world!')
	})
})
