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
				const importMap = createImportMap(registeredImports)

				for (const node of program.body) {
					if (node.type === "ImportDeclaration") {
						importMap.addFromImportDecl(node)
					}
				}

				const trackedNames = importMap.getTrackedNames()

				const sv = new ScopedVisitor<RecordData>({
					trackedNames,
					walk: (program, visitor) => new Visitor(visitor).visit(program),
					visitor: {
						//
					},
				})

				const records = sv.walk(program)

				console.log(context.css("bg-black"))

				return
			}),
		},
	}
}
