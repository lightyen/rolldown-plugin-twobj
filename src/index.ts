import type { Plugin } from "rolldown"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { ScopedVisitor } from "oxc-unshadowed-visitor"
import { Visitor, type ESTree } from "rolldown/utils"
import { createImportMap, expandImportMap } from "./import-map.js"
import type { TwobjPluginOptions } from "./types.js"
import {
	ExprKind,
	regexEscape,
	unescapeTemplateRaw,
	escapeJSString,
	checkTrailingCommaExistence,
	maybeComma,
} from "./common.js"
import { withMagicString } from "rolldown-string"
import { createContext, resolveConfig } from "twobj"
import type * as twobj from "twobj"

interface RecordData {
	nodeStart: number
	nodeEnd: number
	isFullReplace: boolean
	apply: (getTarget: () => string) => void
}

function getValue(node: ESTree.TemplateLiteral): string | null {
	const n = node.quasis[0]
	if (n == null) {
		return null
	}
	return n.value.cooked ?? n.value.raw
}

export default function twobjPlugin(options: TwobjPluginOptions = {}): Plugin {
	let isDev = false
	const registeredImports = expandImportMap()

	const tailwindConfig = resolveConfig(options.tailwindConfig ?? {})
	const context = createContext(tailwindConfig)

	return {
		name: "rolldown-plugin-twobj",
		// @ts-expect-error Vite-specific property
		enforce: "pre",

		// @ts-expect-error Vite-specific hook
		async configResolved(config) {
			isDev = !config.isProduction
		},

		outputOptions() {
			if ("viteVersion" in this.meta) return
			isDev = process.env.NODE_ENV === "development"
		},

		transform: {
			filter: {
				id: /\.[jt]sx?$/,
				code: new RegExp(
					Array.from(new Set(Object.values(registeredImports).flatMap(Object.keys)))
						.map(regexEscape)
						.join("|"),
				),
			},

			handler: withMagicString(function (this, s, id, meta) {
				const lang = id.endsWith(".tsx")
					? "tsx"
					: id.endsWith(".ts")
						? "ts"
						: id.endsWith(".jsx")
							? "jsx"
							: "js"
				const program = meta?.ast ?? this.parse(s.original, { lang })

				const sourceContent = s.original
				const fileStem = path.basename(id, path.extname(id))
				const dirName = path.basename(path.dirname(id))

				let targetCount = 0
				const importMap = createImportMap(registeredImports)

				for (const node of program.body) {
					if (node.type === "ImportDeclaration") {
						importMap.addFromImportDecl(node)
					}
				}

				const trackedNames = importMap.getTrackedNames()

				const labelContextStack: (string | null)[] = [null]
				let inJsx = false
				const sv = new ScopedVisitor<RecordData>({
					trackedNames,
					walk: (program, visitor) => new Visitor(visitor).visit(program),
					visitor: {
						VariableDeclarator(node) {
							let ctx = null
							if (node.id.type === "Identifier") {
								ctx = node.id.name
							}
							// Named function expression overrides variable name
							if (node.init?.type === "FunctionExpression" && node.init.id) {
								ctx = node.init.id.name
							}
							labelContextStack.push(ctx)
						},
						"VariableDeclarator:exit"() {
							labelContextStack.pop()
						},

						FunctionDeclaration(node) {
							// Function declarations always have an id
							labelContextStack.push(node.id!.name)
						},
						"FunctionDeclaration:exit"() {
							labelContextStack.pop()
						},

						Property(node) {
							let ctx = null
							if (!node.computed) {
								if (node.key.type === "Identifier") ctx = node.key.name
								else if (node.key.type === "Literal" && typeof node.key.value === "string")
									ctx = node.key.value
							}
							labelContextStack.push(ctx)
						},
						"Property:exit"() {
							labelContextStack.pop()
						},

						ClassDeclaration(node) {
							const name = node.id?.name ?? labelContextStack[labelContextStack.length - 1]
							labelContextStack.push(name)
						},
						"ClassDeclaration:exit"() {
							labelContextStack.pop()
						},

						PropertyDefinition(node) {
							let ctx = labelContextStack[labelContextStack.length - 1]
							if (node.key.type === "Identifier" && !node.computed) {
								ctx = node.key.name
							}
							labelContextStack.push(ctx)
						},
						"PropertyDefinition:exit"() {
							labelContextStack.pop()
						},

						TaggedTemplateExpression(node, ctx) {
							const tag = node.tag
							const quasi = node.quasi
							const labelContext = labelContextStack[labelContextStack.length - 1]

							// --- css`...` / keyframes`...` ---
							if (tag.type === "Identifier") {
								const meta = importMap.get(tag.name)
								if (
									meta?.type === "named" &&
									(meta.kind === ExprKind.Tw || meta.kind === ExprKind.Tx)
								) {
									const kind = meta.kind
									ctx.record({
										name: tag.name,
										node,
										data: {
											nodeStart: node.start,
											nodeEnd: node.end,
											isFullReplace: true,
											apply: () => {
												// const args = buildTaggedTemplateArgs(
												// 	quasi,
												// 	wasInJsx,
												// 	labelContext,
												// 	node.start,
												// 	kind,
												// )
												const styleText = getValue(quasi)
												if (styleText != null) {
													const v = context.css(styleText)

													let p = JSON.stringify(v)

													console.log(s.slice(node.start, node.end), p)
													s.update(node.start, node.end, p)
												}
											},
										},
									})
									return
								}
							}

							// --- styled.div`...` / namespace.css`...` ---
							// if (tag.type === "MemberExpression" && !tag.computed && tag.object.type === "Identifier") {
							// 	const meta = importMap.get(tag.object.name)
							// 	if (meta?.type === "named" && meta.kind === ExprKind.Styled) {
							// 		ctx.record({
							// 			name: tag.object.name,
							// 			node,
							// 			data: {
							// 				nodeStart: node.start,
							// 				nodeEnd: node.end,
							// 				isFullReplace: true,
							// 				apply: getTarget => {
							// 					let labelObj = `target: "${getTarget()}"`
							// 					if (shouldAddLabel()) {
							// 						const label = createLabel(labelContext, false)
							// 						labelObj += `, label: "${escapeJSString(label)}"`
							// 					}

							// 					const styledArgs = buildTaggedTemplateArgs(
							// 						quasi,
							// 						false,
							// 						labelContext,
							// 						node.start,
							// 						ExprKind.Css,
							// 						false,
							// 					)
							// 					const styledName = s.slice(tag.object.start, tag.object.end)
							// 					const propName = tag.property.name
							// 					s.update(
							// 						node.start,
							// 						node.end,
							// 						`${styledName}("${escapeJSString(propName)}", {\n${labelObj}\n})(${styledArgs})`,
							// 					)
							// 					s.appendLeft(node.start, "/* @__PURE__ */ ")
							// 				},
							// 			},
							// 		})
							// 		return
							// 	}

							// 	// --- namespace.css`...` / namespace.keyframes`...` ---
							// 	if (meta?.type === "namespace") {
							// 		const propName = tag.property.type === "Identifier" ? tag.property.name : null
							// 		const propKind = propName ? meta.config[propName] : undefined
							// 		if (propKind !== ExprKind.Css && propKind !== ExprKind.Keyframes) return

							// 		const kind = propKind
							// 		let wasInJsx = inJsx
							// 		ctx.record({
							// 			name: tag.object.name,
							// 			node,
							// 			data: {
							// 				nodeStart: node.start,
							// 				nodeEnd: node.end,
							// 				isFullReplace: true,
							// 				apply: () => {
							// 					const tagText = s.slice(tag.start, tag.end)
							// 					const args = buildTaggedTemplateArgs(
							// 						quasi,
							// 						wasInJsx,
							// 						labelContext,
							// 						node.start,
							// 						kind,
							// 					)
							// 					s.update(node.start, node.end, `${tagText}(${args})`)
							// 					s.appendLeft(node.start, "/* @__PURE__ */ ")
							// 				},
							// 			},
							// 		})
							// 		return
							// 	}
							// }

							// --- styled(Component)`...` ---
							// if (tag.type === "CallExpression" && tag.callee.type === "Identifier") {
							// 	const meta = importMap.get(tag.callee.name)
							// 	if (meta?.type === "named" && meta.kind === ExprKind.Styled) {
							// 		ctx.record({
							// 			name: tag.callee.name,
							// 			node,
							// 			data: {
							// 				nodeStart: node.start,
							// 				nodeEnd: node.end,
							// 				isFullReplace: true,
							// 				apply: getTarget => {
							// 					const styledName = s.slice(tag.callee.start, tag.callee.end)
							// 					const target = getTarget()
							// 					let labelObj = `target: "${target}"`
							// 					if (shouldAddLabel()) {
							// 						const label = createLabel(labelContext, false)
							// 						labelObj += `, label: "${escapeJSString(label)}"`
							// 					}

							// 					// Extract existing args from styled(Component, ...)
							// 					const existingArgs = tag.arguments
							// 					const firstArgText =
							// 						existingArgs.length > 0
							// 							? s.slice(existingArgs[0].start, existingArgs[0].end)
							// 							: ""

							// 					let innerCallText: string
							// 					if (existingArgs.length <= 1) {
							// 						// styled(Component) → styled(Component, { target, label })
							// 						innerCallText = `${styledName}(${firstArgText}, {\n${labelObj}\n})`
							// 					} else {
							// 						// styled(Component, options) → need to merge options
							// 						const secondArg = existingArgs[1]
							// 						if (secondArg.type === "ObjectExpression") {
							// 							// Merge target/label into existing object
							// 							const objText = s.slice(secondArg.start + 1, secondArg.end - 1)
							// 							const isEmpty = objText.trim() === ""
							// 							const hasTrailingComma =
							// 								!isEmpty && objText.trimEnd().endsWith(",")
							// 							const prefix = isEmpty
							// 								? ""
							// 								: `${objText}${maybeComma(!hasTrailingComma)} `
							// 							innerCallText = `${styledName}(${firstArgText}, { ${prefix}${labelObj} })`
							// 						} else {
							// 							// Wrap with spread
							// 							const secondArgText = s.slice(secondArg.start, secondArg.end)
							// 							innerCallText = `${styledName}(${firstArgText}, {\n${labelObj},\n\t...${secondArgText}\n})`
							// 						}
							// 					}

							// 					const styledArgs = buildTaggedTemplateArgs(
							// 						quasi,
							// 						false,
							// 						labelContext,
							// 						node.start,
							// 						ExprKind.Css,
							// 						false,
							// 					)
							// 					s.update(node.start, node.end, `${innerCallText}(${styledArgs})`)
							// 					s.appendLeft(node.start, "/* @__PURE__ */ ")
							// 				},
							// 			},
							// 		})
							// 		return
							// 	}
							// }
						},
					},
				})

				const records = sv.walk(program)

				if (records.length === 0) {
					return
				}

				const consumedRanges: [number, number][] = []
				for (const record of records) {
					const { nodeStart, nodeEnd, isFullReplace, apply } = record.data
					// Skip records fully contained within an already-consumed range
					// (e.g., inner tagged template inside an outer one that was replaced)
					if (consumedRanges.some(([cs, ce]) => nodeStart >= cs && nodeEnd <= ce)) {
						continue
					}

					apply(() => `e${targetCount++}`)

					if (isFullReplace) {
						consumedRanges.push([nodeStart, nodeEnd])
					}
				}

				return
			}),
		},
	}
}
