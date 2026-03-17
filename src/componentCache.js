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

export async function buildComponentCache(html, rootDir, runtime) {
  const fileSources = new Set()
  const onPageIds = new Set()

  const urlRe = /x-component\.[a-z-]+(?:\.[a-z-]+)*\s*=\s*(["'])([\s\S]*?)\1/gi
  const onPageRe = /\bx-component\s*=\s*(["'])([\s\S]*?)\1/gi
  let m = null

  while ((m = urlRe.exec(html)) !== null) {
    const fullPath = resolveSourcePath(rootDir, m[2])
    if (fullPath) fileSources.add(fullPath)
  }
  while ((m = onPageRe.exec(html)) !== null) {
    const id = parseMaybeQuoted(m[2])
    if (id) onPageIds.add(id)
  }

  const cache = {}

  for (const fullPath of fileSources) {
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
