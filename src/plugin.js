import fs from 'node:fs/promises'
import path from 'node:path'
import { format as prettierFormat } from 'prettier'
import { buildComponentCache } from './componentCache.js'
import { renderAll } from './render.js'
import { evalAlpineProvider, evalAllAlpineStores } from './stores.js'
import { evalObjectExpression, parseMaybeQuoted, pathExists } from './utils.js'

function convertServerDirectivesForServe(html) {
  if (/\bs-bind:x-data=/i.test(html)) {
    console.error(
      '[bake-alpine-components] s-bind:x-data is not allowed. Use x-data directly — props are available in scope via the host wrapper.'
    )
  }
  return html
    .replace(/(<template\b[^>]*\s)s-for=/g, '$1x-for=')
    .replace(/(<template\b[^>]*\s)s-if=/g, '$1x-if=')
    .replace(/\bs-text=/g, 'x-text=')
    .replace(/\bs-html=/g, 'x-html=')
    .replace(/\bs-class=/g, ':class=')
    .replace(/\bs-style=/g, ':style=')
    .replace(/\bs-show=/g, 'x-show=')
    .replace(/\bs-bind:x-data\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\bs-bind:([a-zA-Z][a-zA-Z0-9-]*)=/g, ':$1=')
    .replace(/\bs-if=/g, 'x-if=')
}

export default function bakeAlpineComponentsPlugin(options = {}) {
  const strict = options.strict ?? true
  const verbose = options.verbose ?? false
  const validateComponentPaths = options.validateComponentPaths ?? true
  let outDir = path.join(process.cwd(), 'dist')
  let command = 'build'

  const runtime = {
    strict,
    verbose,
    validateComponentPaths,
    log: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
  }

  return {
    name: 'bake-alpine-components',
    configResolved(config) {
      command = config.command
      outDir = path.resolve(config.root, config.build.outDir)
    },
    async transformIndexHtml(html, ctx) {
      if (command === 'serve') return convertServerDirectivesForServe(html)

      const rootDir = process.cwd()
      if (runtime.verbose) {
        runtime.log(`[bake-alpine-components] bake: ${ctx?.filename || ctx?.path || 'index.html'}`)
      }

      const componentCache = await buildComponentCache(html, rootDir, runtime)

      let rootData = {}

      if (/\bx-data\b/i.test(html) || /\bs-for\b/i.test(html)) {
        const mainPath = path.join(rootDir, 'src', 'main.js')
        const mainSource = await fs.readFile(mainPath, 'utf8')
        const allStores = await evalAllAlpineStores(mainSource, rootDir, mainPath)

        const rootDataMatch = html.match(/x-data\s*=\s*(["'])([\s\S]*?)\1/i)
        if (rootDataMatch) {
          const rootExpr = rootDataMatch[2].trim()
          try {
            rootData = evalObjectExpression(rootExpr)
          } catch {
            if (rootExpr.startsWith('$store.')) {
              rootData = allStores[rootExpr.slice('$store.'.length).trim()] ?? {}
            } else {
              rootData = evalAlpineProvider(mainSource, parseMaybeQuoted(rootExpr)) ?? {}
            }
          }
        }

        rootData.$store = allStores
      }

      rootData.__componentHTML__ = componentCache

      const collectedStyles = []
      const seenStyles = new Set()

      const baked = renderAll(
        html,
        rootData,
        rootDir,
        runtime,
        new Set(),
        collectedStyles,
        seenStyles
      )

      let staticHtml = baked
      if (collectedStyles.length > 0) {
        const styleTag = `<style data-baked-components>\n${collectedStyles.join('\n')}\n</style>`
        staticHtml = staticHtml.replace('</head>', `${styleTag}\n</head>`)
      }

      try {
        return await prettierFormat(staticHtml, {
          parser: 'html',
          printWidth: 100,
          htmlWhitespaceSensitivity: 'ignore',
        })
      } catch {
        return staticHtml
      }
    },
    async closeBundle() {
      const distComponents = path.join(outDir, 'components')
      await fs.rm(distComponents, { recursive: true, force: true })

      const nestedPagesDir = path.join(outDir, 'src', 'pages')
      const targetPagesDir = path.join(outDir, 'pages')
      if (await pathExists(nestedPagesDir)) {
        await fs.mkdir(targetPagesDir, { recursive: true })
        await fs.cp(nestedPagesDir, targetPagesDir, { recursive: true, force: true })
        await fs.rm(path.join(outDir, 'src'), { recursive: true, force: true })
      }
    },
  }
}
