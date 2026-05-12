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
import { createContext, CSSProperties, resolveConfig } from "twobj"

type TextRange = [number, number]

type RangeLike = TextRange | { start: number; end: number }

const enum TransformedKind {
	String = 1,
	CssParts,
	WrapCallExpr,
	StyledCallExpr,
}

type Transformed = TransformedString | TransformedCssParts | TransformedWrapCallExpr

interface TransformedString {
	kind: TransformedKind.String
	value: string
}

interface TransformedCssParts {
	kind: TransformedKind.CssParts
	value: string
	parts: TextRange[]
	append: boolean
	tw: TextRange
}

interface TransformedWrapCallExpr {
	kind: TransformedKind.WrapCallExpr
	callee: string
	arguments: TextRange[]
}

interface TransformedStyledCallExpr {
	kind: TransformedKind.StyledCallExpr
	callee: string
	arguments: TextRange[]
}

interface RecordData {
	start: number
	end: number
	transform(): Transformed
}

interface AdvancedRecordData {
	node: RecordData
	children?: Set<AdvancedRecordData>
}

function rangeIn(target: RangeLike, g: RangeLike): boolean {
	const ts = target instanceof Array ? target[0] : target.start
	const te = target instanceof Array ? target[1] : target.end
	const gs = g instanceof Array ? g[0] : g.start
	const ge = g instanceof Array ? g[1] : g.end
	return ts >= gs && te <= ge
}

function getQuasiValue(node: ESTree.TemplateLiteral): string {
	const n = node.quasis[0]
	if (n == null) {
		return ""
	}
	return n.value.cooked ?? n.value.raw
}

const eRegex = new RegExp(`${Math.E.toString().replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "g")

export default function twobjPlugin(options: TwobjPluginOptions = {}): Plugin {
	let isDev = false
	const registeredImports = expandImportMap()

	const tailwindConfig = resolveConfig(options.tailwindConfig ?? {})
	const tw = createContext(tailwindConfig)

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

				const importMap = createImportMap(registeredImports)

				for (const node of program.body) {
					if (node.type === "ImportDeclaration") {
						importMap.addFromImportDecl(node)
					}
				}

				const trackedNames = importMap.getTrackedNames()

				let needEmotionCss = false
				let needEmotionStyled = false
				let dataIndex = 0
				const cached = new Map<string, number>()

				interface Item {
					kind: ExprKind
					data: unknown
				}
				const dataArray: (Item | null)[] = []

				function jsxAttributeValue(node: ESTree.JSXAttribute | null): string {
					if (!node) {
						return ""
					}
					const value = node.value
					if (!value) {
						return ""
					}
					if (value.type === "Literal") {
						return value.value
					}
					if (
						value.type === "JSXExpressionContainer" &&
						value.expression.type === "Literal" &&
						typeof value.expression.value === "string"
					) {
						return value.expression.value
					}
					return ""
				}

				function jsxCssExpr(node: ESTree.JSXAttribute | null): [number, number][] {
					if (!node) {
						return []
					}
					const value = node.value
					if (!value) {
						return []
					}
					if (value.type === "JSXExpressionContainer") {
						if (value.expression.type === "ArrayExpression") {
							return value.expression.elements
								.filter(e => !!e)
								.map<TextRange>(({ start, end }) => [start, end])
						}
						return [[value.expression.start, value.expression.end]]
					}
					return []
				}

				function addData(kind: ExprKind, input: string): string {
					let i = cached.get(input)
					if (i == undefined) {
						i = dataIndex
						cached.set(input, i)
						switch (kind) {
							case ExprKind.Tw:
								dataArray[i] = { kind, data: tw.css(input) }
								needEmotionCss = true
								break
							case ExprKind.Tx:
								dataArray[i] = { kind, data: tw.css(input) }
								break
							case ExprKind.Theme:
								dataArray[i] = { kind, data: buildTheme(tw.theme(input)) }
								break
							case ExprKind.Wrap:
								dataArray[i] = { kind, data: tw.wrap(input)(Math.E as unknown as CSSProperties) }
								break
							case ExprKind.EmotionStyled:
								needEmotionStyled = true
								break
							default:
								dataArray[i] = null
						}
						dataIndex += 1
					}
					return `_tw[${i}]`
				}

				const sv = new ScopedVisitor<RecordData>({
					trackedNames,
					walk: (program, visitor) => new Visitor(visitor).visit(program),
					visitor: {
						Program(node, ctx) {
							let hasEmotionCss = false
							let hasEmotionStyled = false

							let meta = importMap.get("css")
							if (meta?.type === "named" && meta.kind === ExprKind.EmotionCss) {
								hasEmotionCss = true
							}

							meta = importMap.get("styled")
							if (meta?.type === "named" && meta.kind === ExprKind.EmotionStyled) {
								hasEmotionStyled = true
							}

							ctx.record({
								name: "tw",
								node,
								data: {
									start: 0,
									end: 0,
									transform: () => {
										let value = "const _tw = [];"
										if (needEmotionCss && !hasEmotionCss) {
											value = `import { css } from "@emotion/react";\n` + value
										}
										if (needEmotionStyled && !hasEmotionStyled) {
											value = `import styled from "@emotion/styled";\n` + value
										}
										for (let i = 0; i < dataArray.length; i++) {
											const item = dataArray[i]
											if (item) {
												let result = JSON.stringify(item.data)
												if (item.kind === ExprKind.Tw) {
													result = `css(${result})`
												} else if (item.kind === ExprKind.Wrap) {
													result = `(e)=>(${result.replace(eRegex, "e")})`
												}
												value = value + `_tw[${i}] = ${result};`
											} else {
												value = value + `_tw[${i}] = null;`
											}
										}
										return { kind: TransformedKind.String, value }
									},
								},
							})
						},

						/**
						 * <div tw="bg-black" /> ==> <div css={_tw[<i>]} />
						 */
						JSXElement(node, ctx) {
							const opening = node.openingElement
							let tw: ESTree.JSXAttribute | undefined
							let css: ESTree.JSXAttribute | undefined

							for (const attr of opening.attributes) {
								if (attr.type === "JSXAttribute") {
									if (attr.name.name === "tw") {
										tw ??= attr
									}
									if (attr.name.name === "css") {
										css ??= attr
									}
								}
								if (tw && css) {
									break
								}
							}

							if (!tw) {
								return
							}

							if (!css) {
								// <div tw="bg-black" /> ==> <div css={_tw[<i>]} />
								const input = jsxAttributeValue(tw)
								if (!input) {
									return
								}

								const data = addData(ExprKind.Tw, input)
								const [start, end] = [tw.start, tw.end]
								ctx.record({
									name: "tw",
									node,
									data: {
										start: start,
										end: end,
										transform: () => ({ kind: TransformedKind.String, value: `css={${data}}` }),
									},
								})
								return
							}

							// <div tw="bg-black" css={} /> ==> <div css={[_tw[<i>], ...]} />
							const input = jsxAttributeValue(tw)
							if (!input) {
								return
							}

							const [tw_start, tw_end] = [tw.start, tw.end]
							const [css_start, css_end] = [css.start, css.end]
							const css_content = jsxCssExpr(css)
							const data = addData(ExprKind.Tw, input)
							ctx.record({
								name: "tw",
								node,
								data: {
									start: css_start,
									end: css_end,
									transform: () => {
										return {
											kind: TransformedKind.CssParts,
											value: data,
											parts: css_content,
											append: tw_start > css_start,
											tw: [tw_start, tw_end],
										} satisfies TransformedCssParts
									},
								},
							})
						},
						CallExpression(node, ctx) {
							if (
								node.callee.type !== "TaggedTemplateExpression" ||
								node.callee.tag.type !== "Identifier"
							) {
								return
							}

							const meta = importMap.get(node.callee.tag.name)
							if (meta?.type !== "named") {
								return
							}

							const kind = meta.kind
							if (kind === ExprKind.Wrap) {
								node.callee.parent = node
							}
						},
						// --- tw`...` / tx`...` ---
						// tw`` => css({...})
						// tx`` => {...}
						// theme`` => ...
						// wrap``(payload) ==> ((e) => ({...}))(payload)
						TaggedTemplateExpression(node, ctx) {
							const tag = node.tag
							const quasi = node.quasi

							if (tag.type === "Identifier") {
								const meta = importMap.get(tag.name)
								if (meta?.type !== "named") {
									return
								}

								const kind = meta.kind

								if (kind === ExprKind.Wrap) {
									const input = getQuasiValue(quasi)
									const data = addData(ExprKind.Wrap, input)

									if (node.parent?.type === "CallExpression") {
										const call_expr = node.parent
										const args = call_expr.arguments.map<TextRange>(({ start, end }) => [
											start,
											end,
										])
										ctx.record({
											name: "wrap",
											node: call_expr,
											data: {
												start: call_expr.start,
												end: call_expr.end,
												transform: () => {
													return {
														kind: TransformedKind.WrapCallExpr,
														callee: data,
														arguments: args,
													} satisfies TransformedWrapCallExpr
												},
											},
										})
										return
									}
								}

								if (
									kind === ExprKind.Tw ||
									kind === ExprKind.Tx ||
									kind === ExprKind.Theme ||
									ExprKind.Wrap
								) {
									const input = getQuasiValue(quasi)
									const data = addData(kind, input)
									ctx.record({
										name: tag.name,
										node,
										data: {
											start: node.start,
											end: node.end,
											transform: () => ({ kind: TransformedKind.String, value: data }),
										},
									})
									return
								}

								return
							}

							// tw.input`` ==> styled.input({...})
							if (tag.type === "MemberExpression") {
								return
							}

							// tw("input")`` ==> styled("input")({...})
							if (tag.type === "CallExpression") {
								return
							}
						},
					},
				})

				const records = sv.walk(program)

				if (records.length === 0) {
					return
				}

				const root: AdvancedRecordData = {
					node: {
						start: 0,
						end: s.length(),
						transform: () => ({ kind: TransformedKind.String, value: "" }),
					},
				}

				function insert(target: RecordData, e: AdvancedRecordData): boolean {
					const { start, end } = target
					if (start < e.node.start || end > e.node.end) {
						return false
					}

					if (!e.children) {
						e.children = new Set([{ node: target }])
						return true
					}

					for (const child of e.children) {
						if (insert(target, child)) {
							return true
						}
					}

					const children = new Set<AdvancedRecordData>()
					for (const c of e.children) {
						if (c.node.start >= start && c.node.end <= end) {
							children.add(c)
							e.children.delete(c)
						}
					}

					e.children.add({ node: target, children })
					return true
				}

				for (const record of records) {
					const data = record.data
					insert(data, root)
				}

				function render(e: AdvancedRecordData): [Transformed, string] {
					const t = e.node.transform()
					if (t.kind === TransformedKind.String) {
						return [t, t.value]
					}

					if (t.kind === TransformedKind.CssParts) {
						const parts = t.parts.map(([a, b]) => s.slice(a, b))

						if (e.children) {
							for (const c of e.children) {
								const index = t.parts.findIndex(p => rangeIn(c.node, p))
								if (index !== -1) {
									const [_, inner] = render(c)
									parts[index] =
										s.slice(t.parts[index][0], c.node.start) +
										inner +
										s.slice(c.node.end, t.parts[index][1])
								}
							}
						}

						if (t.append) {
							parts.push(t.value)
						} else {
							parts.unshift(t.value)
						}
						return [t, `css={[${parts.join(",")}]}`]
					}

					const args = t.arguments.map(([a, b]) => s.slice(a, b))

					if (e.children) {
						for (const c of e.children) {
							const index = t.arguments.findIndex(p => rangeIn(c.node, p))
							if (index !== -1) {
								const [_, inner] = render(c)
								args[index] =
									s.slice(t.arguments[index][0], c.node.start) +
									inner +
									s.slice(c.node.end, t.arguments[index][1])
							}
						}
					}

					return [t, `${t.callee}(${args.join(",")})`]
				}

				if (root.children) {
					for (const c of root.children) {
						const [t, value] = render(c)

						if (t.kind === TransformedKind.CssParts) {
							s.remove(...t.tw)
						}

						const { start, end } = c.node
						if (start === end) {
							s.prependRight(start, value)
						} else {
							s.update(start, end, value)
						}
					}
				}

				return
			}),
		},
	}
}

function buildTheme(value: unknown): unknown {
	if (Array.isArray(value) && value.every(v => typeof v === "string")) {
		return value.join(", ")
	}
	return value
}
