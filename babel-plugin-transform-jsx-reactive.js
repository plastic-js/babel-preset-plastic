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
