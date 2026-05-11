import type { Plugin } from "rolldown"
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

export default function twobjPlugin(options: TwobjPluginOptions = {}): Plugin {
	let isDev = false
	const registeredImports = expandImportMap()

	return {
		name: "rolldown-plugin-twobj",
		// @ts-expect-error Vite-specific property
		enforce: "pre",

		// @ts-expect-error Vite-specific hook
		configResolved(config) {
			isDev = !config.isProduction
		},

		outputOptions() {
			if ("viteVersion" in this.meta) return
			isDev = process.env.NODE_ENV === "development"
		},

		transform: {
			filter: {
				id: /\.[jt]sx?$/,
				code: new RegExp(Object.keys(registeredImports).map(regexEscape).join("|")),
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
				const importMap = createImportMap(registeredImports)

				for (const node of program.body) {
					if (node.type === "ImportDeclaration") {
						importMap.addFromImportDecl(node)
					}
				}

				console.log(importMap.getTrackedNames())

				return
			}),
		},
	}
}
