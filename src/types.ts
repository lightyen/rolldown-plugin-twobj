export interface ImportMapEntry {
	/**
	 * The canonical emotion import this maps to
	 * @example ["@emotion/styled", "default"]
	 */
	canonicalImport: [packageName: string, exportName: string]

	/**
	 * The styled base import for this package
	 * @example ["package/base", "something"]
	 */
	styledBaseImport?: [packageName: string, exportName: string]
}

export type ImportMapConfig = Record<string, ImportMapEntry>

export interface TwobjPluginOptions {
	/**
	 * Generate source maps for emotion CSS.
	 * @default true for development, otherwise false
	 */
	sourceMap?: boolean
}
