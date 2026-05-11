import { createRequire } from "node:module"

export async function isModuleExist(id: string) {
	const require = createRequire(import.meta.url)
	try {
		// @ts-expect-error
		require.resolve(id, { paths: Module["_nodeModulePaths"](process.cwd()) })
		return true
	} catch {
		return false
	}
}

export interface ThirdParty {
	name: string // ex: emotion
	styled?: string // ex: @emotion/styled
	className?: string // ex: @emotion/css
}
