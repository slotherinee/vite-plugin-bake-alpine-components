import fs from 'node:fs/promises'
import { parseMaybeQuoted, parseTemplateInner, pathExists, resolveSourcePath } from './utils.js'

function findMatchingTemplateClose(html, fromIndex) {
  const closeRe = /<\/template\s*>/gi
  let depth = 1
  let cursor = fromIndex

  while (cursor < html.length) {
    const nextOpen = html.indexOf('<template', cursor)
    closeRe.lastIndex = cursor
    const closeMatch = closeRe.exec(html)
    if (!closeMatch) return null
    const nextClose = closeMatch.index

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1
      cursor = nextOpen + 9
      continue
    }

    depth -= 1
    if (depth === 0) return { start: nextClose, end: closeRe.lastIndex }
    cursor = closeRe.lastIndex
  }

  return null
}

function extractOnPageTemplateById(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const openRe = new RegExp(`<template\\b[^>]*\\bid\\s*=\\s*(["'])${escaped}\\1[^>]*>`, 'i')
  const openMatch = openRe.exec(html)
  if (!openMatch) return null

  const openStart = openMatch.index
  const openEnd = openStart + openMatch[0].length
  const close = findMatchingTemplateClose(html, openEnd)
  if (!close) return null

  return html.slice(openEnd, close.start).trim()
}

function collectComponentRefs(source, rootDir) {
  const paths = new Set()
  const urlRe = /x-component\.[a-z-]+(?:\.[a-z-]+)*\s*=\s*(["'])([\s\S]*?)\1/gi
  let m = null
  while ((m = urlRe.exec(source)) !== null) {
    const fullPath = resolveSourcePath(rootDir, m[2])
    if (fullPath) paths.add(fullPath)
  }
  return paths
}

export async function buildComponentCache(html, rootDir, runtime) {
  const onPageIds = new Set()
  const onPageRe = /\bx-component\s*=\s*(["'])([\s\S]*?)\1/gi
  let m = null
  while ((m = onPageRe.exec(html)) !== null) {
    const id = parseMaybeQuoted(m[2])
    if (id) onPageIds.add(id)
  }

  const cache = {}

  // BFS: start from index.html, recursively discover components referenced in component files
  const queue = [...collectComponentRefs(html, rootDir)]
  const visited = new Set(queue)

  while (queue.length > 0) {
    const fullPath = queue.shift()

    if (runtime.validateComponentPaths && !(await pathExists(fullPath))) {
      const msg = `[bake-alpine-components] Component file not found: ${fullPath}`
      if (runtime.strict) throw new Error(msg)
      runtime.warn(msg)
      continue
    }
    try {
      const tpl = await fs.readFile(fullPath, 'utf8')
      cache[fullPath] = parseTemplateInner(tpl)
      if (runtime.verbose) runtime.log(`[bake-alpine-components] cache: ${fullPath}`)

      // Discover components referenced inside this component file
      for (const childPath of collectComponentRefs(tpl, rootDir)) {
        if (!visited.has(childPath)) {
          visited.add(childPath)
          queue.push(childPath)
        }
      }
    } catch (error) {
      const msg = `[bake-alpine-components] Could not read component: ${fullPath}\n${error.message}`
      if (runtime.strict) throw new Error(msg)
      runtime.warn(msg)
    }
  }

  for (const id of onPageIds) {
    const extracted = extractOnPageTemplateById(html, id)
    if (extracted != null) {
      cache[id] = extracted
      if (runtime.verbose) runtime.log(`[bake-alpine-components] cache on-page: #${id}`)
    } else {
      const msg = `[bake-alpine-components] On-page template not found: <template id="${id}">`
      if (runtime.strict) throw new Error(msg)
      runtime.warn(msg)
    }
  }

  return cache
}
