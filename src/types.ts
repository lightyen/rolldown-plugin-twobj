export interface TwobjPluginOptions {
	/**
	 * Generate source maps for emotion CSS.
	 * @default true for development, otherwise false
	 */
	sourceMap?: boolean

	tailwindConfig?: import("twobj").ConfigJS
	throwError?: boolean
	debug?: boolean
}
