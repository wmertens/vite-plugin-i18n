import {resolve} from 'node:path'
import {type Plugin} from 'vite'
import fs from 'node:fs'
import type {Locale, Data, Key} from 'vite-plugin-i18n'
import {replaceGlobals, transformLocalize} from './transform-localize'

/**
 * TODO
 *
 * - [ ] in client strip the setLocaleGetter and setDefaultLocale calls, and
 *   replace `__$LOCALE$__` with the locale
 * - [ ] track missing and unused translations
 * - [ ] optionally add missing translations to the locale files
 * - [ ] optionally move unused translations to a `unused{}` in the locale files
 * - [ ] optionally warn about dynamic translations
 */

type Options = {
	/** The locales you want to support */
	locales?: string[]
	/** The directory where the locale files are stored, defaults to /i18n */
	localesDir?: string
	/** The default locale, defaults to the first locale */
	defaultLocale?: string
	/** Extra Babel plugins to use when transforming the code */
	babelPlugins?: any[]
}

// const c = (...args: any[]): any => {
// 	console.log('vite i18n', ...args)
// 	return args[0]
// }

export function i18nPlugin(options: Options = {}): Plugin {
	const {localesDir = 'i18n', babelPlugins} = options
	const locales = options.locales || ['en']
	const defaultLocale = options.defaultLocale || locales[0]
	const localeNames = {}
	const localesDirAbs = resolve(process.cwd(), localesDir)

	let shouldInline = false
	let translations: Record<Locale, Data>
	let pluralKeys: Set<Key>
	return {
		name: 'i18n',
		enforce: 'pre',
		// For now, don't run during dev
		apply: 'build',

		configResolved(config) {
			shouldInline = !!config.build.ssr || !config.isProduction
		},

		buildStart() {
			// Ensure the locales dir exists
			fs.mkdirSync(localesDirAbs, {recursive: true})
			// Verify/generate the locale files
			const fallbacks = {}
			translations = {}
			pluralKeys = new Set()
			for (const locale of locales!) {
				const match = /^([a-z]{2})([_-]([A-Z]{2}))?$/.exec(locale)
				if (!match)
					throw new Error(
						`Invalid locale: ${locale} (does not match xx or xx_XX))`
					)
				const localeFile = resolve(localesDirAbs, `${locale}.json`)
				let data: Data
				if (fs.existsSync(localeFile)) {
					data = JSON.parse(fs.readFileSync(localeFile, 'utf8')) as Data
					if (data.locale !== locale)
						throw new Error(
							`Invalid locale file: ${localeFile} (locale mismatch ${data.locale} !== ${locale})`
						)
					if (!data.name)
						data.name = match[3] ? `${match[1]} (${match[3]})` : locale
					if (data.fallback) {
						if (!locales!.includes(data.fallback))
							throw new Error(
								`Invalid locale file: ${localeFile} (invalid fallback ${data.fallback})`
							)
						let follow
						while ((follow = fallbacks[data.fallback])) {
							if (follow === locale) {
								throw new Error(
									`Invalid locale file: ${localeFile} (circular fallback ${data.fallback})`
								)
							}
						}
						fallbacks[locale] = data.fallback
					}
				} else {
					data = {
						locale,
						name: match[3] ? `${match[1]} (${match[3]})` : locale,
						translations: {},
					}
					fs.writeFileSync(localeFile, JSON.stringify(data, null, 2))
				}
				localeNames[locale] = data.name
				translations[locale] = data
				for (const [key, tr] of Object.entries(data.translations))
					if (tr && typeof tr === 'object') pluralKeys.add(key)
			}
		},

		// Redirect to our virtual data files
		async resolveId(id) {
			// c('resolveId', id, importer, await this.getModuleInfo(id))
			if (id.includes('/i18n/__locales.')) return '\0i18n-locales.js'
			if (id.includes('/i18n/__data.')) return '\0i18n-data.js'
			if (id.includes('/i18n/__state.')) return '\0i18n-state.js'
		},

		// Load our virtual data files
		async load(id) {
			// c('load', id, await this.getModuleInfo(id))
			if (id === '\0i18n-locales.js') {
				return shouldInline
					? ''
					: `
/**
 * This file was generated by vite-plugin-i18n.
 *
 * For server builds, it contains all translations. For client builds, it is
 * empty, and translations need to be loaded dynamically.
 */
${locales!
	.map(l => `export {default as ${l}} from '${localesDirAbs}/${l}.json'`)
	.join('\n')}
`
			}
			if (id === '\0i18n-data.js') {
				return `
/** This file is generated at build time by \`vite-plugin-i18n\`. */
/** @type {import('vite-plugin-i18n').Locale[]} */
export const locales = ${JSON.stringify(locales)}
/** @type {Record<import('vite-plugin-i18n').Locale, string>} */
export const localeNames = ${JSON.stringify(localeNames)}
`
			}
			if (id === '\0i18n-state.js') {
				return `
/** This file is generated at build time by \`vite-plugin-i18n\`. */
import {localeNames} from '/i18n/__data.js'

/** @typedef {import('vite-plugin-i18n').Locale} Locale */
/** @type {Locale} */
export let defaultLocale = ${
					shouldInline ? '__$LOCALE$__' : JSON.stringify(defaultLocale)
				}
/** @type {Locale} */
export let currentLocale = defaultLocale

const _checkLocale = l => {
	if (!localeNames[l]) throw new TypeError(\`unknown locale \${l}\`)
}
/** @type {(locale: Locale) => void} */
export const setDefaultLocale = l => {
	_checkLocale(l)
	defaultLocale = l
}
export let getLocale = () => defaultLocale
/** @type {(fn: () => Locale | undefined) => void} */
export const setLocaleGetter = fn => {
	getLocale = () => {
		const l = fn() || defaultLocale
		_checkLocale(l)
		currentLocale = l
	  return l
	}
}
`
			}
		},

		async transform(code, id) {
			if (!shouldInline || !/\.(cjs|js|mjs|ts|jsx|tsx)($|\?)/.test(id))
				return null
			// c('transform', id, await this.getModuleInfo(id))

			return transformLocalize({id, code, pluralKeys, babelPlugins})
		},

		// Emit the translated files as assets under locale subdirectories
		generateBundle(_options, bundle) {
			if (!shouldInline) return
			for (const locale of locales!) {
				for (const [fileName, chunk] of Object.entries(bundle)) {
					if ('code' in chunk) {
						const translatedCode = replaceGlobals({
							code: chunk.code,
							locale,
							translations,
						})
						this.emitFile({
							type: 'asset',
							fileName: `${locale}/${fileName}`,
							source: translatedCode,
						})
					} else {
						// Simply copy existing assets
						this.emitFile({
							type: 'asset',
							fileName: `${locale}/${fileName}`,
							source: chunk.source,
						})
					}
				}
			}
		},
	}
}
