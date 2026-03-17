import fs from 'node:fs/promises'
import path from 'node:path'
import { evalObjectExpression } from './utils.js'

export function evalAlpineProvider(mainSource, providerName) {
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
  while ((match = importRe.exec(mainSource)) !== null) imports.set(match[1], match[3])
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
      // try next
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
  if (inlineMatch) return evalObjectExpression(inlineMatch[2])

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

export async function evalAllAlpineStores(mainSource, rootDir, mainPath) {
  const stores = {}
  const storeNameRe = /Alpine\.store\(\s*(["'])([\s\S]*?)\1\s*,/g
  const seen = new Set()
  let match = null
  while ((match = storeNameRe.exec(mainSource)) !== null) {
    const storeName = (match[2] || '').trim()
    if (!storeName || seen.has(storeName)) continue
    seen.add(storeName)
    const storeValue = await evalAlpineStore(mainSource, storeName, rootDir, mainPath)
    if (storeValue) stores[storeName] = storeValue
  }
  return stores
}
