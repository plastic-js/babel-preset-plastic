/**
 * babel-plugin-transform-jsx-reactive
 *
 * Rewrites each JSX element's attribute list and children into a single
 * `mergeProps(...)` call so that the runtime sees one reactive proxy per
 * element, regardless of how many spreads or sibling attributes appear.
 *
 *   <MyComp {...api()} foo={2} bar={state.b}>{kid}</MyComp>
 *   →
 *   jsx(MyComp, mergeProps(() => api(), {
 *     foo: 2,
 *     get bar() { return state.b },
 *     children: () => kid,
 *   }))
 *
 * `mergeProps` returns a Proxy: reading `proxy.bar` invokes the getter, which
 * is where the reactive system observes signal reads. Static expressions
 * (literals, identifiers, inline functions, etc.) are emitted as plain values
 * so they incur no proxy overhead.
 *
 * Consecutive non-spread attributes are grouped into one object literal;
 * spread attributes are passed through as positional arguments to mergeProps,
 * preserving JSX prop-order semantics (later sources override earlier ones
 * for normal keys; class/style/ref/onXxx have their own merge rules in
 * `src/merge-props.js`).
 *
 * Children are injected as a `children` property on the trailing object group
 * (with dynamic individual children wrapped in thunks). The visitor emits the
 * final `jsx(Tag, mergeProps(...))` call directly — `@babel/preset-react` is
 * not involved.
 *
 * Dynamic event handlers (e.g. `onClick={state.handler}`) are passed through
 * as-is — the runtime's `applyProps` attaches one listener that resolves the
 * handler via the proxy on each invocation, so reassigning the handler takes
 * effect without re-binding.
 */

const plugin = function(babel){
	const { types: t } = babel

	// ---------------------------------------------------------------------------
	// Static-expression analysis: values classified as static are emitted as
	// plain object properties; everything else becomes a getter so the runtime
	// can observe signal reads on access.
	// ---------------------------------------------------------------------------

	const unwrapExpression = (node)=> {
		if (t.isTSAsExpression?.(node) || t.isTSSatisfiesExpression?.(node) || t.isTSNonNullExpression?.(node) || t.isTypeCastExpression?.(node)){
			return unwrapExpression(node.expression)
		}
		if (t.isParenthesizedExpression(node)){
			return unwrapExpression(node.expression)
		}
		return node
	}

	const isAlwaysStaticNode = (node)=> {
		return t.isStringLiteral(node)
			|| t.isNumericLiteral(node)
			|| t.isBooleanLiteral(node)
			|| t.isNullLiteral(node)
			|| t.isBigIntLiteral?.(node)
			|| t.isRegExpLiteral?.(node)
			// Identifiers are treated as static here:
			//  - `createTree` data structures are inherently reactive, so they
			//    need no compile-time wrapping.
			//  - Plain signal identifiers are detected and unwrapped by the
			//    runtime `jsx` function itself.
			// Therefore no special handling is required at this layer.
			|| t.isIdentifier(node)
			|| t.isThisExpression(node)
			|| t.isArrowFunctionExpression(node)
			|| t.isFunctionExpression(node)
	}

	const isAlwaysReactiveNode = (node)=> {
		return t.isMemberExpression(node)
			|| t.isOptionalMemberExpression?.(node)
			|| t.isCallExpression(node)
			|| t.isOptionalCallExpression?.(node)
			|| t.isNewExpression(node)
			|| t.isAwaitExpression?.(node)
			|| t.isYieldExpression?.(node)
			|| t.isAssignmentExpression(node)
			|| t.isUpdateExpression(node)
			|| t.isTaggedTemplateExpression(node)
	}

	const isStaticExpression = (input)=> {
		const node = unwrapExpression(input)
		if (!node){
			return true
		}

		if (isAlwaysStaticNode(node)){
			return true
		}

		if (t.isJSXElement(node)){
			return false
		}

		if (t.isJSXFragment(node)){
			return node.children.every(child=> t.isJSXText(child) && child.value.trim() === '')
		}

		if (isAlwaysReactiveNode(node)){
			return false
		}

		if (t.isUnaryExpression(node)){
			return isStaticExpression(node.argument)
		}

		if (t.isBinaryExpression(node) || t.isLogicalExpression(node)){
			return isStaticExpression(node.left) && isStaticExpression(node.right)
		}

		if (t.isConditionalExpression(node)){
			return isStaticExpression(node.test) && isStaticExpression(node.consequent) && isStaticExpression(node.alternate)
		}

		if (t.isTemplateLiteral(node)){
			return node.expressions.every(expression=> isStaticExpression(expression))
		}

		if (t.isArrayExpression(node)){
			return node.elements.every((element)=> {
				if (!element){
					return true
				}
				if (t.isSpreadElement(element)){
					return isStaticExpression(element.argument)
				}
				return isStaticExpression(element)
			})
		}

		if (t.isObjectExpression(node)){
			return node.properties.every((property)=> {
				if (t.isSpreadElement(property)){
					return false
				}
				if (t.isObjectMethod(property)){
					return true
				}
				if (!t.isObjectProperty(property)){
					return false
				}
				const isKeyStatic = property.computed ? isStaticExpression(property.key) : true
				return isKeyStatic && isStaticExpression(property.value)
			})
		}

		if (t.isSequenceExpression(node)){
			return node.expressions.every(expression=> isStaticExpression(expression))
		}

		return false
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	// Tracks JSX nodes we have already rewritten so the visitor does not re-enter
	// them after we replace their attributes / children. Babel continues
	// traversing into the mutated subtree, which would otherwise loop.
	const rewritten = new WeakSet()

	// Tags whose textual content is whitespace-sensitive — collapsing runs of
	// whitespace or stripping leading/trailing whitespace would visibly alter
	// rendered output (e.g. preserved indentation in `<pre>`, formatted source
	// in `<code>`, raw text in `<textarea>` / `<script>` / `<style>`).
	const WHITESPACE_SENSITIVE_TAGS = new Set(['pre', 'textarea', 'code', 'script', 'style'])

	// Single source of truth for "is this JSX child meaningful?" — used by both
	// the child-filtering pass in `buildMergePropsArgs` and the per-child
	// conversion in `jsxChildToExpression`. Whitespace-sensitive parents keep
	// any non-empty JSXText; everything else collapses whitespace and discards
	// runs that trim to empty. JSXEmptyExpression containers are never
	// meaningful.
	// Collapse runs of whitespace in a JSXText value to single spaces. Shared
	// by the meaningfulness check and the actual emission so the two passes
	// can never disagree about what the normalized text is.
	const normalizeJsxText = (value)=> value.replace(/\s+/g, ' ')

	const isMeaningfulChild = (child, parentTagName)=> {
		if (t.isJSXText(child)){
			if (parentTagName && WHITESPACE_SENSITIVE_TAGS.has(parentTagName)){
				return child.value !== ''
			}
			return normalizeJsxText(child.value).trim() !== ''
		}
		if (t.isJSXExpressionContainer(child) && t.isJSXEmptyExpression(child.expression)){
			return false
		}
		return true
	}

	// Convert a JSX child node into a plain expression. Dynamic JSXExpression
	// children are wrapped in a thunk so the runtime's `appendChild` /
	// `node2Element` path detects them and creates a reactive child node,
	// giving per-child re-render granularity. JSXElement children are left
	// as-is — the visitor itself rewrites them into `jsx(...)` calls.
	const jsxChildToExpression = (child, parentTagName)=> {
		if (!isMeaningfulChild(child, parentTagName)){
			return null
		}
		if (t.isJSXText(child)){
			if (parentTagName && WHITESPACE_SENSITIVE_TAGS.has(parentTagName)){
				return t.stringLiteral(child.value)
			}
			return t.stringLiteral(normalizeJsxText(child.value))
		}
		if (t.isJSXExpressionContainer(child)){
			const expr = child.expression
			if (isStaticExpression(expr)){
				return expr
			}
			return t.arrowFunctionExpression([], expr)
		}
		if (t.isJSXSpreadChild(child)){
			return t.spreadElement(child.expression)
		}
		return child
	}

	// Build the literal property key for an attribute name. JSX allows
	// `aria-foo`, `data-bar`, namespaced names like `xlink:href`, etc., none of
	// which are valid JS identifiers — emit them as string literals.
	const jsxNameToKey = (jsxName)=> {
		if (t.isJSXIdentifier(jsxName)){
			const name = jsxName.name
			if ((/^[a-zA-Z_$][\w$]*$/).test(name)){
				return { key: t.identifier(name), name }
			}
			return { key: t.stringLiteral(name), name }
		}
		if (t.isJSXNamespacedName(jsxName)){
			const name = `${jsxName.namespace.name}:${jsxName.name.name}`
			return { key: t.stringLiteral(name), name }
		}
		// Fallback — unreachable for valid JSX.
		return { key: t.stringLiteral(String(jsxName)), name: String(jsxName) }
	}

	// Build the value expression for a JSXAttribute.
	const jsxAttrValueToExpression = (attr)=> {
		if (attr.value == null){
			// `<input disabled />` → `disabled: true`
			return t.booleanLiteral(true)
		}
		if (t.isStringLiteral(attr.value)){
			return attr.value
		}
		if (t.isJSXExpressionContainer(attr.value)){
			if (t.isJSXEmptyExpression(attr.value.expression)){
				// Use `void 0` rather than the `undefined` identifier: in non-strict
				// scopes `undefined` can be shadowed by a local binding, while
				// `void 0` always evaluates to the real undefined value.
				return t.unaryExpression('void', t.numericLiteral(0))
			}
			return attr.value.expression
		}
		if (t.isJSXElement(attr.value) || t.isJSXFragment(attr.value)){
			return attr.value
		}
		return attr.value
	}

	// "Literal-static" classifies an attribute value tightly enough that the
	// runtime can apply it without any reactive-binding machinery: string /
	// numeric / boolean / null literal, or a JSXExpressionContainer wrapping
	// one of those (or a boolean-shorthand attribute with no value).
	// Identifiers do NOT qualify — they can point to a reactive tree proxy.
	const isLiteralStaticAttrValue = (attr)=> {
		if (attr.value == null){
			return true
		}
		if (t.isStringLiteral(attr.value)){
			return true
		}
		if (t.isJSXExpressionContainer(attr.value)){
			const expr = attr.value.expression
			return t.isStringLiteral(expr)
				|| t.isNumericLiteral(expr)
				|| t.isBooleanLiteral(expr)
				|| t.isNullLiteral(expr)
		}
		return false
	}

	// An element qualifies for the jsxStatic fast path when its tag is an
	// intrinsic DOM tag, it has no spread attributes, and every attribute
	// value is a literal. Children are not constrained — they go through the
	// normal reactive path as a separate argument.
	const canEmitJsxStatic = (openingName, jsxAttrs)=> {
		if (!t.isJSXIdentifier(openingName) || !(/^[a-z]/).test(openingName.name)){
			return false
		}
		for (const attr of jsxAttrs){
			if (t.isJSXSpreadAttribute(attr)){
				return false
			}
			if (!isLiteralStaticAttrValue(attr)){
				return false
			}
		}
		return true
	}

	// Build a plain object literal of literal-static attrs. No duplicate
	// tolerance needed here for class/style merging because the static path
	// rejects any element whose attrs require runtime merge semantics; but we
	// still enforce duplicate-attr detection consistent with the reactive
	// path.
	const buildStaticPropsObject = (jsxAttrs, parentTagName, file)=> {
		const seenNames = new Map()
		const properties = []
		for (const attr of jsxAttrs){
			const { key, name } = jsxNameToKey(attr.name)
			if (!DUPLICATE_ALLOWED_ATTRS.has(name)){
				if (seenNames.has(name)){
					const filename = file?.opts?.filename ?? '<unknown>'
					const loc = attr.loc?.start
					const where = loc ? `${filename}:${loc.line}:${loc.column}` : filename
					throw new Error(`[transform-jsx-reactive] duplicate attribute "${name}" on <${parentTagName ?? '?'}> at ${where}`)
				}
				seenNames.set(name, true)
			}
			properties.push(t.objectProperty(key, jsxAttrValueToExpression(attr)))
		}
		return t.objectExpression(properties)
	}

	// Attribute names that are allowed to appear more than once on the same
	// element — `mergeProps` has dedicated merge rules for class/style, so
	// duplicates are intentional usage, not author error.
	const DUPLICATE_ALLOWED_ATTRS = new Set(['class', 'className', 'style'])

	// Construct an ObjectExpression from a list of JSXAttributes (non-spread),
	// plus an optional synthetic `children` source. `seenNames` is owned by the
	// caller (`buildMergePropsArgs`) so duplicate detection spans the entire
	// element, not just one consecutive non-spread group.
	const buildObjectExpression = (jsxAttrs, syntheticChildren, parentTagName, file, seenNames)=> {
		const properties = []

		for (const attr of jsxAttrs){
			const { key, name } = jsxNameToKey(attr.name)

			if (!DUPLICATE_ALLOWED_ATTRS.has(name)){
				if (seenNames.has(name)){
					const filename = file?.opts?.filename ?? '<unknown>'
					const loc = attr.loc?.start
					const where = loc ? `${filename}:${loc.line}:${loc.column}` : filename
					throw new Error(`[transform-jsx-reactive] duplicate attribute "${name}" on <${parentTagName ?? '?'}> at ${where}`)
				}
				seenNames.set(name, true)
			}

			const value = jsxAttrValueToExpression(attr)

			if (isStaticExpression(value)){
				properties.push(t.objectProperty(key, value))
				continue
			}

			// Dynamic: emit as a getter so reading the proxy invokes the expression
			// inside the current tracking scope.
			const getter = t.objectMethod('get', key, [], t.blockStatement([
				t.returnStatement(value),
			]))
			properties.push(getter)
		}

		if (syntheticChildren && syntheticChildren.length > 0){
			const childExprs = syntheticChildren.map(child=> jsxChildToExpression(child, parentTagName)).filter(Boolean)
			if (childExprs.length > 0){
				const key = t.identifier('children')
				const value = childExprs.length === 1 && !t.isSpreadElement(childExprs[0])
					? childExprs[0]
					: t.arrayExpression(childExprs)
				properties.push(t.objectProperty(key, value))
			}
		}

		return t.objectExpression(properties)
	}

	// Group attributes so that consecutive non-spread attributes form one
	// ObjectExpression while spreads remain positional. Children are attached
	// to the trailing object group (creating one if necessary).
	const buildMergePropsArgs = (jsxAttrs, jsxChildren, parentTagName, file)=> {
		// Element-scoped duplicate tracking: shared across every object group on
		// this element so a spread sitting between two same-named attrs cannot
		// hide the duplication. Spreads themselves don't contribute names (their
		// contents are dynamic and resolved at runtime by `mergeProps`).
		const seenNames = new Map()
		const groups = []
		for (const attr of jsxAttrs){
			if (t.isJSXSpreadAttribute(attr)){
				groups.push({ kind: 'spread', node: attr.argument })
			} else {
				const last = groups[groups.length - 1]
				if (last && last.kind === 'object'){
					last.attrs.push(attr)
				} else {
					groups.push({ kind: 'object', attrs: [attr] })
				}
			}
		}

		const meaningfulChildren = jsxChildren.filter(child=> isMeaningfulChild(child, parentTagName))

		if (meaningfulChildren.length > 0){
			const last = groups[groups.length - 1]
			if (last && last.kind === 'object'){
				last.syntheticChildren = meaningfulChildren
			} else {
				groups.push({ kind: 'object', attrs: [], syntheticChildren: meaningfulChildren })
			}
		}

		return groups.map((group)=> {
			if (group.kind === 'spread'){
				// Dynamic spread sources (e.g. `{...api()}`) must be wrapped in a
				// thunk so `mergeProps` can re-evaluate them when their signal
				// dependencies change. Static sources (object literals, plain
				// identifiers) are passed through directly.
				if (isStaticExpression(group.node)){
					return group.node
				}
				return t.arrowFunctionExpression([], group.node)
			}
			return buildObjectExpression(group.attrs, group.syntheticChildren, parentTagName, file, seenNames)
		})
	}

	// ---------------------------------------------------------------------------
	// Compile-time DOM template fast path
	//
	// A JSX subtree that contains nothing but intrinsic tags, literal attribute
	// values, and literal children can be serialized to an HTML string at build
	// time. The runtime parses that string once per module into a detached
	// <template> node; each render site emits `_tmpl.cloneNode(true)` and skips
	// jsx/mergeProps/applyProps entirely.
	// ---------------------------------------------------------------------------

	const VOID_ELEMENTS = new Set([
		'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
		'link', 'meta', 'source', 'track', 'wbr',
	])

	const jsxAttrNameToHtml = (name)=> {
		if (name === 'className'){
			return 'class'
		}
		if (name === 'htmlFor'){
			return 'for'
		}
		return name
	}

	const escapeAttrValue = (value)=> String(value)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')

	const escapeText = (value)=> String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')

	const isStaticLiteralNode = (node)=> {
		if (!node){
			return true
		}
		return t.isStringLiteral(node)
			|| t.isNumericLiteral(node)
			|| t.isBooleanLiteral(node)
			|| t.isNullLiteral(node)
	}

	const literalNodeToValue = (node)=> {
		if (!node){
			return true
		}
		if (t.isNullLiteral(node)){
			return null
		}
		return node.value
	}

	// "Foldable" = this element can have its skeleton serialized into HTML.
	// Requires intrinsic tag, no spread attrs, and non-namespaced attr names.
	// Attribute values and children may be arbitrary (literals fold into HTML,
	// dynamics become setProp/insert holes). Non-foldable children (components,
	// fragments, spread children, foldable-violating intrinsics) become insert
	// holes too — they get re-visited by babel inside the accessor body.
	const isFoldableElement = (node)=> {
		if (!t.isJSXElement(node)){
			return false
		}
		const opening = node.openingElement
		if (!t.isJSXIdentifier(opening.name)){
			return false
		}
		if (!(/^[a-z]/).test(opening.name.name)){
			return false
		}
		for (const attr of opening.attributes){
			if (!t.isJSXAttribute(attr)){
				return false
			}
			if (!t.isJSXIdentifier(attr.name)){
				return false
			}
		}
		return true
	}

	// Compile a foldable JSXElement into a plan describing:
	//   - a tree of "compiled nodes" mirroring the DOM the template will create
	//   - a list of ops (setProp / insert) to run on the cloned tree
	// Pure-static subtrees produce zero ops, so the caller can emit just
	// `tmpl.cloneNode(true)` without the IIFE wrapper.
	const compileTemplatePlan = (rootJsx)=> {
		const ops = []

		const compileElement = (jsxEl, parent, indexInParent)=> {
			const tag = jsxEl.openingElement.name.name
			const node = {
				kind: 'element',
				tag,
				parent,
				indexInParent,
				staticAttrs: [],
				dynamicAttrs: [],
				children: [],
				needsLocal: false,
				localName: null,
			}

			for (const attr of jsxEl.openingElement.attributes){
				const jsName = attr.name.name
				const htmlName = jsxAttrNameToHtml(jsName)

				if (attr.value == null){
					node.staticAttrs.push({ name: htmlName, value: true })
					continue
				}
				if (t.isStringLiteral(attr.value)){
					node.staticAttrs.push({ name: htmlName, value: attr.value.value })
					continue
				}
				if (t.isJSXExpressionContainer(attr.value)){
					const expr = attr.value.expression
					if (t.isJSXEmptyExpression(expr)){
						continue
					}
					if (isStaticLiteralNode(expr)){
						const v = literalNodeToValue(expr)
						if (v === false || v == null){
							continue
						}
						node.staticAttrs.push({ name: htmlName, value: v })
						continue
					}
					node.dynamicAttrs.push({ key: jsName, expr })
					continue
				}
				// JSXElement / JSXFragment as attribute value — treat as dynamic.
				node.dynamicAttrs.push({ key: jsName, expr: attr.value })
			}

			// Children: filter whitespace-only, then classify each.
			const meaningful = jsxEl.children.filter(child=> isMeaningfulChild(child, tag))
			const singleChild = meaningful.length === 1

			let domIdx = 0
			for (const child of meaningful){
				if (t.isJSXText(child)){
					const raw = WHITESPACE_SENSITIVE_TAGS.has(tag) ? child.value : normalizeJsxText(child.value)
					node.children.push({
						kind: 'text',
						text: raw,
						parent: node,
						indexInParent: domIdx,
						children: [],
						needsLocal: false,
						localName: null,
					})
					domIdx += 1
					continue
				}
				if (t.isJSXExpressionContainer(child)){
					const expr = child.expression
					if (t.isJSXEmptyExpression(expr)){
						continue
					}
					if (isStaticLiteralNode(expr)){
						const v = literalNodeToValue(expr)
						// null / true / false render to nothing in HTML.
						if (v == null || v === false || v === true){
							continue
						}
						node.children.push({
							kind: 'text',
							text: String(v),
							parent: node,
							indexInParent: domIdx,
							children: [],
							needsLocal: false,
							localName: null,
						})
						domIdx += 1
						continue
					}
					// Dynamic child hole.
					if (singleChild){
						ops.push({ kind: 'insert', parentNode: node, markerNode: null, expr })
						continue
					}
					const markerNode = {
						kind: 'marker',
						parent: node,
						indexInParent: domIdx,
						children: [],
						needsLocal: false,
						localName: null,
					}
					node.children.push(markerNode)
					ops.push({ kind: 'insert', parentNode: node, markerNode, expr })
					domIdx += 1
					continue
				}
				if (t.isJSXElement(child) && isFoldableElement(child)){
					const childNode = compileElement(child, node, domIdx)
					node.children.push(childNode)
					domIdx += 1
					continue
				}
				// Non-foldable JSX child (component, fragment, spread child,
				// nested element with spreads/namespaced attrs): treat as a
				// dynamic insert hole. The JSXElement / JSXFragment node is
				// placed verbatim into the accessor body; babel re-traverses
				// the IIFE and processes it through the regular jsx/mergeProps
				// path.
				if (singleChild){
					ops.push({ kind: 'insert', parentNode: node, markerNode: null, expr: child })
					continue
				}
				const markerNode = {
					kind: 'marker',
					parent: node,
					indexInParent: domIdx,
					children: [],
					needsLocal: false,
					localName: null,
				}
				node.children.push(markerNode)
				ops.push({ kind: 'insert', parentNode: node, markerNode, expr: child })
				domIdx += 1
			}

			// Schedule setProp ops for this element's dynamic attrs.
			for (const attr of node.dynamicAttrs){
				ops.push({ kind: 'setProp', elNode: node, key: attr.key, expr: attr.expr })
			}

			return node
		}

		const compiledRoot = compileElement(rootJsx, null, 0)

		// Mark which compiled nodes need a local binding in the IIFE.
		compiledRoot.needsLocal = true
		for (const op of ops){
			if (op.kind === 'setProp'){
				op.elNode.needsLocal = true
				continue
			}
			if (op.kind === 'insert'){
				op.parentNode.needsLocal = true
				if (op.markerNode){
					op.markerNode.needsLocal = true
				}
			}
		}

		return { root: compiledRoot, ops }
	}

	// Render the compiled tree to HTML. Markers emit a `<!>` comment, which
	// the browser parses as an empty comment node — exactly the runtime
	// anchor `insert(parent, accessor, marker)` needs.
	const treeToHtml = (node)=> {
		if (node.kind === 'text'){
			return escapeText(node.text)
		}
		if (node.kind === 'marker'){
			return '<!>'
		}
		// element
		let html = `<${node.tag}`
		for (const attr of node.staticAttrs){
			if (attr.value === true){
				html += ` ${attr.name}`
				continue
			}
			html += ` ${attr.name}="${escapeAttrValue(attr.value)}"`
		}
		html += '>'
		if (VOID_ELEMENTS.has(node.tag)){
			return html
		}
		for (const child of node.children){
			html += treeToHtml(child)
		}
		html += `</${node.tag}>`
		return html
	}

	// Build a navigation expression from a "near" local (an ancestor that has
	// its own local binding) down to `target`. The path is a sequence of
	// child-indices; each index becomes `.firstChild` followed by N
	// `.nextSibling`s.
	const buildNavigationExpr = (ancestorLocalName, steps)=> {
		let expr = t.identifier(ancestorLocalName)
		for (const idx of steps){
			expr = t.memberExpression(expr, t.identifier('firstChild'))
			for (let i = 0; i < idx; i += 1){
				expr = t.memberExpression(expr, t.identifier('nextSibling'))
			}
		}
		return expr
	}

	// Walk up from `node` to its nearest already-locallized ancestor,
	// collecting the child-index path. Returns { ancestor, steps[] }.
	const pathFromNearestLocal = (node)=> {
		const steps = []
		let cur = node
		while (cur.parent != null){
			steps.unshift(cur.indexInParent)
			cur = cur.parent
			if (cur.needsLocal){
				return { ancestor: cur, steps }
			}
		}
		return { ancestor: cur, steps }
	}

	// Wrap a dynamic expression for use as a setProp/insert accessor. The
	// runtime's setProp/insert only set up a binding effect when handed a
	// function; non-function values take a static one-shot path. So unlike the
	// mergeProps path (where the proxy's get-trap supplies reactivity), here
	// identifiers must be wrapped too — otherwise a tree-proxy passed as
	// `style={styles}` would never re-apply when its fields mutate. Literals
	// and arrow/function expressions stay as-is: literals can't be reactive,
	// and arrow/function values are typically event handlers / refs that the
	// runtime needs to receive verbatim.
	const accessorFor = (expr)=> {
		const node = unwrapExpression(expr)
		if (!node){
			return expr
		}
		if (t.isStringLiteral(node)
			|| t.isNumericLiteral(node)
			|| t.isBooleanLiteral(node)
			|| t.isNullLiteral(node)
			|| t.isBigIntLiteral?.(node)
			|| t.isRegExpLiteral?.(node)
			|| t.isArrowFunctionExpression(node)
			|| t.isFunctionExpression(node)){
			return expr
		}
		return t.arrowFunctionExpression([], expr)
	}

	// Hoist a module-level `const _tmplN = template('...')` declaration,
	// deduped by HTML string so identical subtrees share one template node.
	const ensureTemplate = (path, html)=> {
		const program = path.findParent(p=> p.isProgram()) ?? path.hub?.file?.path
		const templateId = ensureRuntimeImport(path, 'template')

		if (!program){
			return t.callExpression(templateId, [t.stringLiteral(html)])
		}

		let cache = program.getData('templateCache')
		if (!cache){
			cache = new Map()
			program.setData('templateCache', cache)
		}
		const cached = cache.get(html)
		if (cached){
			return t.identifier(cached)
		}

		const local = program.scope.generateUidIdentifier('tmpl')
		const decl = t.variableDeclaration('const', [
			t.variableDeclarator(local, t.callExpression(templateId, [t.stringLiteral(html)])),
		])

		const body = program.node.body
		let insertIdx = 0
		for (let i = 0; i < body.length; i += 1){
			if (t.isImportDeclaration(body[i])){
				insertIdx = i + 1
				continue
			}
			break
		}
		body.splice(insertIdx, 0, decl)
		cache.set(html, local.name)
		return t.identifier(local.name)
	}

	const RUNTIME = '@plastic-js/plastic/jsx-runtime'

	// Ensure the file imports `name` from the Plastic JSX runtime. In module
	// mode, adds an ImportSpecifier (re-using one if present). In script mode
	// (tests that pass code through `new Function`), returns a bare identifier
	// of the same name; the test harness is responsible for providing that
	// binding.
	const ensureRuntimeImport = (path, name)=> {
		const program = path.findParent(p=> p.isProgram()) ?? path.hub?.file?.path
		if (!program){
			return t.identifier(name)
		}
		if (program.node.sourceType !== 'module'){
			return t.identifier(name)
		}

		const cacheKey = `runtimeImport:${name}`
		const cachedId = program.getData(cacheKey)
		if (cachedId){
			return t.identifier(cachedId)
		}

		for (const stmt of program.node.body){
			if (!t.isImportDeclaration(stmt)){
				continue
			}
			if (stmt.source.value !== RUNTIME){
				continue
			}
			for (const specifier of stmt.specifiers){
				if (t.isImportSpecifier(specifier) && t.isIdentifier(specifier.imported, { name })){
					program.setData(cacheKey, specifier.local.name)
					return t.identifier(specifier.local.name)
				}
			}
			const local = program.scope.generateUidIdentifier(name)
			stmt.specifiers.push(t.importSpecifier(local, t.identifier(name)))
			program.setData(cacheKey, local.name)
			return t.identifier(local.name)
		}

		const local = program.scope.generateUidIdentifier(name)
		const importDecl = t.importDeclaration(
			[t.importSpecifier(local, t.identifier(name))],
			t.stringLiteral(RUNTIME),
		)
		program.unshiftContainer('body', importDecl)
		program.setData(cacheKey, local.name)
		return t.identifier(local.name)
	}

	// Resolve the object part of a JSXMemberExpression to a JS expression.
	// Unlike the standalone tag case, every node here references a JS value
	// chain (e.g. `Theme.Provider`, `ark.div`), so a leading lowercase
	// identifier is still a variable reference — never an intrinsic string.
	const jsxMemberObjectToExpression = (node)=> {
		if (t.isJSXIdentifier(node)){
			return t.identifier(node.name)
		}
		if (t.isJSXMemberExpression(node)){
			return t.memberExpression(jsxMemberObjectToExpression(node.object), t.identifier(node.property.name))
		}
		return t.identifier(String(node))
	}

	// Convert a JSXOpeningElement's tag name to a JS expression suitable as the
	// first argument of `jsx(...)`. Standalone lower-case identifiers become
	// string literals (intrinsic DOM tags); upper-case identifiers, namespaced
	// names, and member expressions become references to the corresponding
	// component / namespaced tag.
	const jsxTagToExpression = (name)=> {
		if (t.isJSXIdentifier(name)){
			if ((/^[a-z]/).test(name.name)){
				return t.stringLiteral(name.name)
			}
			return t.identifier(name.name)
		}
		if (t.isJSXMemberExpression(name)){
			return t.memberExpression(jsxMemberObjectToExpression(name.object), t.identifier(name.property.name))
		}
		if (t.isJSXNamespacedName(name)){
			return t.stringLiteral(`${name.namespace.name}:${name.name.name}`)
		}
		return t.identifier(String(name))
	}

	return {
		name: 'transform-jsx-reactive',
		visitor: {
			JSXElement(path, state){
				const node = path.node
				if (rewritten.has(node)){
					return
				}
				rewritten.add(node)

				const opening = node.openingElement
				const attrs = opening.attributes
				const children = node.children

				const tagExpr = jsxTagToExpression(opening.name)
				const parentTagName = t.isJSXIdentifier(opening.name) ? opening.name.name : null

				// Template path: foldable intrinsic subtrees compile to an HTML
				// template + per-hole setProp/insert calls. We only fire at the
				// topmost foldable element; nested foldable children get folded
				// into the parent's HTML during compileTemplatePlan. Pure-static
				// subtrees (no dynamic holes) short-circuit to a bare
				// `tmpl.cloneNode(true)` — no IIFE wrapper.
				if (isFoldableElement(node)){
					const parentPath = path.parentPath
					const parentIsFoldable = parentPath
						&& parentPath.isJSXElement()
						&& isFoldableElement(parentPath.node)
					if (!parentIsFoldable){
						const plan = compileTemplatePlan(node)
						const html = treeToHtml(plan.root)
						const tmplId = ensureTemplate(path, html)

						if (plan.ops.length === 0){
							path.replaceWith(t.callExpression(
								t.memberExpression(tmplId, t.identifier('cloneNode')),
								[t.booleanLiteral(true)],
							))
							return
						}

						// Assign locals to needsLocal nodes in pre-order; emit
						// declarations as we go so each declaration's RHS can
						// reference its nearest already-declared ancestor.
						const stmts = []
						let counter = 0
						const assignLocals = (cnode)=> {
							if (cnode.needsLocal){
								const name = `_el${counter}`
								counter += 1
								cnode.localName = name
								if (cnode.parent == null){
									stmts.push(t.variableDeclaration('const', [
										t.variableDeclarator(
											t.identifier(name),
											t.callExpression(
												t.memberExpression(tmplId, t.identifier('cloneNode')),
												[t.booleanLiteral(true)],
											),
										),
									]))
								} else {
									const { ancestor, steps } = pathFromNearestLocal(cnode)
									stmts.push(t.variableDeclaration('const', [
										t.variableDeclarator(
											t.identifier(name),
											buildNavigationExpr(ancestor.localName, steps),
										),
									]))
								}
							}
							for (const child of cnode.children){
								assignLocals(child)
							}
						}
						assignLocals(plan.root)

						const setPropId = ensureRuntimeImport(path, 'setProp')
						const insertId = ensureRuntimeImport(path, 'insert')

						for (const op of plan.ops){
							if (op.kind === 'setProp'){
								stmts.push(t.expressionStatement(
									t.callExpression(setPropId, [
										t.identifier(op.elNode.localName),
										t.stringLiteral(op.key),
										accessorFor(op.expr),
									]),
								))
								continue
							}
							// insert
							const args = [
								t.identifier(op.parentNode.localName),
								accessorFor(op.expr),
							]
							if (op.markerNode){
								args.push(t.identifier(op.markerNode.localName))
							}
							stmts.push(t.expressionStatement(t.callExpression(insertId, args)))
						}

						stmts.push(t.returnStatement(t.identifier(plan.root.localName)))

						// If any insert hole could render a component (uppercase JSX,
						// member-expression tag, fragment, or arbitrary expression),
						// the synchronous IIFE would call `_insert` under the caller's
						// `currentOwner` — so a Provider sitting between this template
						// and a descendant Consumer would be skipped by useContext's
						// owner walk. Emit a thunk in that case and let the runtime
						// invoke it while materializing the enclosing component, so
						// component children land under the correct owner. Pure-DOM
						// templates (only intrinsic inserts, setProps) are unaffected
						// and keep the eager IIFE.
						const isComponentInsertExpr = (expr)=> {
							if (t.isJSXElement(expr)){
								const name = expr.openingElement.name
								if (t.isJSXIdentifier(name) && (/^[A-Z]/).test(name.name)){
									return true
								}
								if (t.isJSXMemberExpression(name)){
									return true
								}
								return false
							}
							if (t.isJSXFragment(expr)){
								return true
							}
							return true
						}
						const needsThunk = plan.ops.some(op=> op.kind === 'insert' && isComponentInsertExpr(op.expr))

						const factory = t.arrowFunctionExpression([], t.blockStatement(stmts))
						if (needsThunk){
							path.replaceWith(factory)
							return
						}
						path.replaceWith(t.callExpression(factory, []))
						return
					}
				}

				// Fast path: intrinsic tag + all attrs are literal-static + no
				// spread → emit jsxStatic(tag, propsLiteral, children?). The
				// runtime applies props directly with no reactive checks. Children
				// still flow through the normal jsx pipeline (they may themselves
				// be reactive expressions or jsx() subtrees).
				if (canEmitJsxStatic(opening.name, attrs)){
					const propsExpr = buildStaticPropsObject(attrs, parentTagName, state?.file)
					const meaningfulChildren = children.filter(child=> isMeaningfulChild(child, parentTagName))
					const childExprs = meaningfulChildren
						.map(child=> jsxChildToExpression(child, parentTagName))
						.filter(Boolean)
					const jsxStaticId = ensureRuntimeImport(path, 'jsxStatic')
					const callArgs = [tagExpr, propsExpr]
					if (childExprs.length === 1 && !t.isSpreadElement(childExprs[0])){
						callArgs.push(childExprs[0])
					} else if (childExprs.length > 0){
						callArgs.push(t.arrayExpression(childExprs))
					}
					path.replaceWith(t.callExpression(jsxStaticId, callArgs))
					return
				}

				const args = buildMergePropsArgs(attrs, children, parentTagName, state?.file)

				// No attrs and no meaningful children → emit jsx(Tag, {}) directly.
				let propsExpr
				if (args.length === 0){
					propsExpr = t.objectExpression([])
				} else {
					const mergeId = ensureRuntimeImport(path, 'mergeProps')
					propsExpr = t.callExpression(mergeId, args)
				}

				const jsxId = ensureRuntimeImport(path, 'jsx')
				path.replaceWith(t.callExpression(jsxId, [tagExpr, propsExpr]))
			},

			// Fragments have no attributes and no spread sources, so they skip
			// mergeProps entirely — emit `jsx(Fragment, { children: [...] })`
			// directly. Dynamic individual children are still wrapped in thunks
			// by `buildObjectExpression` to stay reactive.
			// NOTE: a fragment may carry a `key` (e.g. `<>...</>` inside a list),
			// but spread on a fragment is forbidden — that's why we can safely
			// skip mergeProps here.
			JSXFragment(path){
				const node = path.node
				if (rewritten.has(node)){
					return
				}
				rewritten.add(node)

				const children = node.children
				const meaningfulChildren = children.filter(child=> isMeaningfulChild(child, null))

				const propsExpr = meaningfulChildren.length === 0
					? t.objectExpression([])
					: buildObjectExpression([], meaningfulChildren, null, null, new Map())

				const jsxId = ensureRuntimeImport(path, 'jsx')
				const fragmentId = ensureRuntimeImport(path, 'Fragment')
				path.replaceWith(t.callExpression(jsxId, [fragmentId, propsExpr]))
			},
		},
	}
}

export default plugin
