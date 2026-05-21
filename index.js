import controlFlow from './babel-plugin-transform-jsx-control-flow.js'
import reactive from './babel-plugin-transform-jsx-reactive.js'

const preset = ()=> ({
	plugins: [controlFlow, reactive],
})

export default preset
export { controlFlow, reactive }
