import controlFlow from './babel-plugin-transform-jsx-control-flow.js'
import reactive from './babel-plugin-transform-jsx-reactive.js'

// `componentMarker` stamps each component's root intrinsic element with
// `data-comp="<ComponentName>"` for DOM-inspector debugging. It defaults to on
// outside production builds; pass `{ componentMarker: false }` (or `true`) to
// the preset to override. BABEL_ENV takes precedence over NODE_ENV, matching
// Babel's own env resolution.
const preset = (api, opts = {})=> {
	const env = process.env.BABEL_ENV || process.env.NODE_ENV
	const componentMarker = opts.componentMarker ?? env !== 'production'
	return {
		plugins: [
			controlFlow,
			[reactive, { componentMarker }],
		],
	}
}

export default preset
export { controlFlow, reactive }
