import fs from 'node:fs/promises'
import path from 'node:path'
import { format as prettierFormat } from 'prettier'

function parseTemplateInner(html) {
  // Greedy outer template capture so nested <template> blocks are preserved.
  const match = html.match(/^\s*<template[^>]*>([\s\S]*)<\/template>\s*$/i)
  if (!match) return html.trim()
  return match[1].trim()
}

function parseMaybeQuoted(value) {
  if (!value) return ''
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function readAttr(attrs, name) {
  const escaped = name.replace('.', '\\.')
  const re = new RegExp(`${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i')
  const match = attrs.match(re)
  return match ? match[2] : ''
}

function resolveSourcePath(rootDir, sourceExpr) {
  const source = parseMaybeQuoted(sourceExpr)
  if (!source) return ''

  if (source.startsWith('/src/')) return path.join(rootDir, source.slice(1))
  if (source.startsWith('/')) return path.join(rootDir, 'public', source.slice(1))
  return path.join(rootDir, source)
}

function evalObjectExpression(expr) {
  return Function(`"use strict"; return (${expr});`)()
}

function evalAlpineProvider(mainSource, providerName) {
  const escaped = providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `Alpine\\.data\\(\\s*(["'])${escaped}\\1\\s*,\\s*\\(\\)\\s*=>\\s*\\(([\\s\\S]*?)\\)\\s*\\)`
  )
  const match = mainSource.match(re)
  if (!match) return null
  return evalObjectExpression(match[2])
}

function resolveMainImports(mainSource) {
  const imports = new Map()
  const importRe = /import\s+([a-zA-Z_$][\w$]*)\s+from\s*("|')([\s\S]*?)\2/g
  let match = null

  while ((match = importRe.exec(mainSource)) !== null) {
    imports.set(match[1], match[3])
  }

  return imports
}

function extractDefaultExportObject(moduleSource) {
  const wrappedRe = /export\s+default\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?/m
  const wrapped = moduleSource.match(wrappedRe)
  if (wrapped) return wrapped[1]

  const plainRe = /export\s+default\s*(\{[\s\S]*\})\s*;?/m
  const plain = moduleSource.match(plainRe)
  if (plain) return plain[1]

  const namedExportRe = /export\s+default\s+([a-zA-Z_$][\w$]*)\s*;?/m
  const namedExport = moduleSource.match(namedExportRe)
  if (namedExport) {
    const symbol = namedExport[1]
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const declarationRe = new RegExp(
      `(?:const|let|var)\\s+${escaped}\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?[\\s\\S]*export\\s+default\\s+${escaped}\\s*;?`,
      'm'
    )
    const declaration = moduleSource.match(declarationRe)
    if (declaration) return declaration[1]
  }

  return null
}

async function resolveImportedObject(rootDir, importerPath, importPath) {
  const fromDir = path.dirname(importerPath)
  const basePath = importPath.startsWith('/')
    ? path.join(rootDir, importPath.slice(1))
    : path.resolve(fromDir, importPath)

  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.mjs'),
  ]

  for (const candidate of candidates) {
    try {
      const source = await fs.readFile(candidate, 'utf8')
      const objectExpr = extractDefaultExportObject(source)
      if (!objectExpr) return null
      return evalObjectExpression(objectExpr)
    } catch {
      // Try next candidate path.
    }
  }

  return null
}

async function evalAlpineStore(mainSource, storeName, rootDir, mainPath) {
  const escaped = storeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const inlineRe = new RegExp(
    `Alpine\\.store\\(\\s*(["'])${escaped}\\1\\s*,\\s*(\\{[\\s\\S]*?\\})\\s*\\)`
  )
  const inlineMatch = mainSource.match(inlineRe)
  if (inlineMatch) {
    return evalObjectExpression(inlineMatch[2])
  }

  const namedRe = new RegExp(
    `Alpine\\.store\\(\\s*(["'])${escaped}\\1\\s*,\\s*([a-zA-Z_$][\\w$]*)\\s*\\)`
  )
  const namedMatch = mainSource.match(namedRe)
  if (!namedMatch) return null

  const symbolName = namedMatch[2]
  const imports = resolveMainImports(mainSource)
  const importPath = imports.get(symbolName)
  if (!importPath) return null

  return resolveImportedObject(rootDir, mainPath, importPath)
}

async function evalAllAlpineStores(mainSource, rootDir, mainPath) {
  const stores = {}
  const namedStoreRe = /Alpine\.store\(\s*(["'])([\s\S]*?)\1\s*,\s*([a-zA-Z_$][\w$]*)\s*\)/g
  let match = null

  while ((match = namedStoreRe.exec(mainSource)) !== null) {
    const storeName = (match[2] || '').trim()
    if (!storeName) continue
    const storeValue = await evalAlpineStore(mainSource, storeName, rootDir, mainPath)
    if (storeValue) stores[storeName] = storeValue
  }

  return stores
}

function evalInContext(expr, context) {
  return Function('ctx', `with(ctx){ return (${expr}); }`)(context)
}

function truncate(value, max = 220) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

function evalInContextOrThrow(expr, context, runtime, meta = {}) {
  try {
    return evalInContext(expr, context)
  } catch (error) {
    const keys = Object.keys(context || {})
    const where = meta.where || 'expression evaluation'
    const snippet = meta.htmlSnippet ? `\nHTML: ${truncate(meta.htmlSnippet)}` : ''
    const contextKeys = keys.length ? keys.slice(0, 12).join(', ') : '(empty)'
    const message = [
      `[bake-alpine-components] Error in ${where}`,
      `Expression: ${expr}`,
      `Context keys: ${contextKeys}`,
      snippet,
      `Original error: ${error.message}`,
    ]
      .filter(Boolean)
      .join('\n')

    if (runtime.strict) throw new Error(message)
    runtime.warn(message)
    return undefined
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function stripDirectiveAttributes(html) {
  return html
    .replace(/\s+x-data\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-component\.url\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-component-styles\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+styles\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-component\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-text\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s*:key\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-slot\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-slot\b/gi, '')
}

function normalizeAttrs(attrs) {
  const compact = attrs.replace(/\s+/g, ' ').trim()
  return compact ? ` ${compact}` : ''
}

function renderLoopsAndText(html, context, runtime) {
  const xForRe = /<template\s+[^>]*x-for\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/template>/gi

  const withExpandedLoops = html.replace(xForRe, (full, _q, forExpr, inner) => {
    const forMatch = forExpr.match(/^\s*([a-zA-Z_$][\w$]*)\s+in\s+([\s\S]+)$/)
    if (!forMatch) {
      const message = `[bake-alpine-components] Invalid x-for expression: ${forExpr}`
      if (runtime.strict) throw new Error(message)
      runtime.warn(message)
      return full
    }

    const alias = forMatch[1]
    const listExpr = forMatch[2].trim()
    const list = evalInContextOrThrow(listExpr, context, runtime, {
      where: 'x-for list',
      htmlSnippet: full,
    })
    if (!Array.isArray(list)) {
      const message = `[bake-alpine-components] x-for expects an array, got: ${typeof list}. Expression: ${listExpr}`
      if (runtime.strict) throw new Error(message)
      runtime.warn(message)
      return full
    }

    if (runtime.verbose) {
      runtime.log(
        `[bake-alpine-components] x-for: ${truncate(forExpr, 120)} -> ${list.length} item(s)`
      )
    }

    return list
      .map((item, index) => {
        const loopContext = { ...context, [alias]: item, $index: index }
        return renderLoopsAndText(inner, loopContext, runtime)
      })
      .join('')
  })

  const xTextRe =
    /<([a-z0-9-]+)([^>]*?)\s+x-text\s*=\s*(["'])([\s\S]*?)\3([^>]*)>([\s\S]*?)<\/\1>/gi

  const withText = withExpandedLoops.replace(
    xTextRe,
    (full, tag, beforeAttrs, _q, expr, afterAttrs) => {
      const text = escapeHtml(
        evalInContextOrThrow(expr, context, runtime, {
          where: 'x-text',
          htmlSnippet: full,
        })
      )
      const attrs = normalizeAttrs(`${beforeAttrs}${afterAttrs}`)
      return `<${tag}${attrs}>${text}</${tag}>`
    }
  )

  return withText
}

function renderComponentHosts(templateChunk, context, rootDir, runtime, stack = new Set()) {
  const hostRe =
    /<([a-z0-9-]+)([^>]*\bx-component\.url\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)>([\s\S]*?)<\/\1>/gi

  return templateChunk.replace(hostRe, (full, tag, attrsRaw, inner) => {
    const xDataExpr = readAttr(attrsRaw, 'x-data')
    const sourceExpr = readAttr(attrsRaw, 'x-component.url')
    if (!xDataExpr || !sourceExpr) {
      const message =
        '[bake-alpine-components] x-component.url host must have both x-data and x-component.url'
      if (runtime.strict) throw new Error(`${message}\nHTML: ${truncate(full)}`)
      runtime.warn(`${message}\nHTML: ${truncate(full)}`)
      return full
    }

    const xData = evalInContextOrThrow(xDataExpr, context, runtime, {
      where: 'x-component host x-data',
      htmlSnippet: full,
    })
    if (xData === undefined && !runtime.strict) return full

    const componentPath = resolveSourcePath(rootDir, sourceExpr)
    if (!componentPath) {
      const message = `[bake-alpine-components] Could not resolve component path from x-component.url: ${sourceExpr}`
      if (runtime.strict) throw new Error(message)
      runtime.warn(message)
      return full
    }

    if (stack.has(componentPath)) return full
    const nextStack = new Set(stack)
    nextStack.add(componentPath)

    const attrs = `${attrsRaw}`
      .replace(/\s*x-data\s*=\s*(["'])[\s\S]*?\1/i, '')
      .replace(/\s*x-component\.url\s*=\s*(["'])[\s\S]*?\1/i, '')
      .replace(/\s*x-component-styles\s*=\s*(["'])[\s\S]*?\1/i, '')
      .replace(/\s*styles\s*=\s*(["'])[\s\S]*?\1/i, '')

    const resolvedContext = { ...context, ...xData }
    const componentHtml = resolvedContext.__componentHTML__[componentPath] ?? ''
    if (!componentHtml) {
      const message = `[bake-alpine-components] Component not found in cache: ${componentPath}`
      if (runtime.strict) throw new Error(`${message}\nHTML: ${truncate(full)}`)
      runtime.warn(`${message}\nHTML: ${truncate(full)}`)
      return full
    }

    if (runtime.verbose) {
      runtime.log(`[bake-alpine-components] render component: ${componentPath}`)
    }

    const slotTemplatesRe =
      /<template\s+x-slot(?:\s*=\s*(["'])([\s\S]*?)\1)?\s*>([\s\S]*?)<\/template>/gi
    const slotMap = { default: '' }
    let slotMatch = null

    while ((slotMatch = slotTemplatesRe.exec(inner)) !== null) {
      const slotName = (slotMatch[2] || 'default').trim() || 'default'
      const slotTemplate = renderComponentHosts(
        slotMatch[3],
        resolvedContext,
        rootDir,
        runtime,
        nextStack
      )
      slotMap[slotName] = stripDirectiveAttributes(
        renderLoopsAndText(slotTemplate, resolvedContext, runtime)
      )
    }

    const nestedRendered = renderComponentHosts(
      componentHtml,
      resolvedContext,
      rootDir,
      runtime,
      nextStack
    )
    let rendered = renderLoopsAndText(nestedRendered, resolvedContext, runtime)

    rendered = rendered.replace(
      /<slot\s+name\s*=\s*(["'])([\s\S]*?)\1\s*><\/slot>/gi,
      (m, q, name) => {
        const key = (name || '').trim()
        return slotMap[key] ?? ''
      }
    )
    rendered = rendered.replace(/<slot\s*><\/slot>/gi, slotMap.default ?? '')
    rendered = rendered.replace(/<slot\s*\/\s*>/gi, slotMap.default ?? '')

    const staticHtml = stripDirectiveAttributes(rendered)

    return `<${tag}${normalizeAttrs(attrs)}>${staticHtml}</${tag}>`
  })
}

async function buildComponentCache(html, rootDir, runtime) {
  const sources = new Set()
  const sourceRe = /x-component\.url\s*=\s*(["'])([\s\S]*?)\1/gi
  let m = null

  while ((m = sourceRe.exec(html)) !== null) {
    const fullPath = resolveSourcePath(rootDir, m[2])
    sources.add(fullPath)
  }

  const cache = {}
  for (const fullPath of sources) {
    if (runtime.validateComponentPaths && !(await pathExists(fullPath))) {
      const message = `[bake-alpine-components] Component file not found: ${fullPath}`
      if (runtime.strict) throw new Error(message)
      runtime.warn(message)
      continue
    }

    try {
      const tpl = await fs.readFile(fullPath, 'utf8')
      cache[fullPath] = parseTemplateInner(tpl)
    } catch (error) {
      const message = `[bake-alpine-components] Could not read component: ${fullPath}\nOriginal error: ${error.message}`
      if (runtime.strict) throw new Error(message)
      runtime.warn(message)
      continue
    }

    if (runtime.verbose) {
      runtime.log(`[bake-alpine-components] cache component: ${fullPath}`)
    }
  }

  return cache
}

export default function bakeAlpineComponentsPlugin(options = {}) {
  const strict = options.strict ?? true
  const verbose = options.verbose ?? false
  const validateComponentPaths = options.validateComponentPaths ?? true
  let outDir = path.join(process.cwd(), 'dist')

  const runtime = {
    strict,
    verbose,
    validateComponentPaths,
    log: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
  }

  return {
    name: 'bake-alpine-components',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
      if (runtime.verbose) {
        runtime.log(
          `[bake-alpine-components] options: strict=${runtime.strict}, verbose=${runtime.verbose}, validateComponentPaths=${runtime.validateComponentPaths}`
        )
      }
    },
    async transformIndexHtml(html, ctx) {
      const rootDir = process.cwd()
      const htmlLabel = ctx?.filename || ctx?.path || 'index.html'
      if (runtime.verbose) runtime.log(`[bake-alpine-components] bake html: ${htmlLabel}`)

      const componentCache = await buildComponentCache(html, rootDir, runtime)

      const rootDataMatch = html.match(/x-data\s*=\s*(["'])([\s\S]*?)\1/i)
      let rootData = {}

      if (rootDataMatch) {
        const rootExpr = rootDataMatch[2].trim()
        const mainPath = path.join(rootDir, 'src', 'main.js')
        const mainSource = await fs.readFile(mainPath, 'utf8')
        const allStores = await evalAllAlpineStores(mainSource, rootDir, mainPath)

        try {
          rootData = evalObjectExpression(rootExpr)
        } catch {
          if (rootExpr.startsWith('$store.')) {
            const storeName = rootExpr.slice('$store.'.length).trim()
            rootData = allStores[storeName] ?? {}
          } else {
            const providerName = parseMaybeQuoted(rootExpr)
            rootData = evalAlpineProvider(mainSource, providerName) ?? {}
          }
        }

        rootData.$store = allStores
      }

      rootData.__componentHTML__ = componentCache

      const xForRe = /<template\s+[^>]*x-for\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/template>/gi

      const baked = html.replace(xForRe, (full, _q, forExpr, inner) => {
        const forMatch = forExpr.match(/^\s*([a-zA-Z_$][\w$]*)\s+in\s+([\s\S]+)$/)
        if (!forMatch) {
          const message = `[bake-alpine-components] Invalid root x-for expression: ${forExpr}`
          if (runtime.strict) throw new Error(message)
          runtime.warn(message)
          return full
        }

        const alias = forMatch[1]
        const listExpr = forMatch[2].trim()
        const list = evalInContextOrThrow(listExpr, rootData, runtime, {
          where: 'root x-for list',
          htmlSnippet: full,
        })
        if (!Array.isArray(list)) {
          const message = `[bake-alpine-components] root x-for expects an array, got: ${typeof list}. Expression: ${listExpr}`
          if (runtime.strict) throw new Error(message)
          runtime.warn(message)
          return full
        }

        if (runtime.verbose) {
          runtime.log(
            `[bake-alpine-components] root x-for: ${truncate(forExpr, 120)} -> ${list.length} item(s)`
          )
        }

        return list
          .map((item) => {
            const loopContext = { ...rootData, [alias]: item }
            const chunk = renderComponentHosts(inner, loopContext, rootDir, runtime, new Set())
            return chunk
          })
          .join('')
      })

      const withStandaloneHosts = renderComponentHosts(baked, rootData, rootDir, runtime, new Set())
      const staticHtml = withStandaloneHosts

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
