import fs from 'node:fs/promises'
import path from 'node:path'

export function parseTemplateInner(html) {
  const match = html.match(/^\s*<template[^>]*>([\s\S]*)<\/template>\s*$/i)
  if (!match) return html.trim()
  return match[1].trim()
}

export function parseMaybeQuoted(value) {
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

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

export function readAttr(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i')
  const match = attrs.match(re)
  return match ? match[2] : ''
}

export function resolveSourcePath(rootDir, sourceExpr) {
  const source = parseMaybeQuoted(sourceExpr)
  if (!source) return ''
  if (source.startsWith('/src/')) return path.join(rootDir, source.slice(1))
  if (source.startsWith('/')) return path.join(rootDir, 'public', source.slice(1))
  return path.join(rootDir, source)
}

export function evalObjectExpression(expr) {
  return Function(`"use strict"; return (${expr});`)()
}

export function evalInContext(expr, context) {
  return Function('ctx', `with(ctx){ return (${expr}); }`)(context)
}

export function truncate(value, max = 220) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

export function evalInContextOrThrow(expr, context, runtime, meta = {}) {
  try {
    return evalInContext(expr, context)
  } catch (error) {
    const keys = Object.keys(context || {})
    const where = meta.where || 'expression evaluation'
    const snippet = meta.htmlSnippet ? `\nHTML: ${truncate(meta.htmlSnippet)}` : ''
    const message = [
      `[bake-alpine-components] Error in ${where}`,
      `Expression: ${expr}`,
      `Context keys: ${keys.slice(0, 12).join(', ') || '(empty)'}`,
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

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function normalizeAttrs(attrs) {
  const compact = attrs.replace(/\s+/g, ' ').trim()
  return compact ? ` ${compact}` : ''
}

export function findTagEndIndex(html, startIndex) {
  let quote = null
  for (let i = startIndex; i < html.length; i++) {
    const ch = html[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return -1
}

export function findMatchingClosingTag(html, tag, fromIndex) {
  const tokenRe = new RegExp(`<\\/?${tag}(?=[\\s>/])[^>]*>`, 'gi')
  tokenRe.lastIndex = fromIndex
  let depth = 1
  while (true) {
    const match = tokenRe.exec(html)
    if (!match) return null
    const token = match[0]
    const isClosing = token.startsWith('</')
    const isSelfClosing = /\/>\s*$/.test(token)
    if (isClosing) {
      depth -= 1
      if (depth === 0) return { start: match.index, end: tokenRe.lastIndex }
      continue
    }
    if (!isSelfClosing) depth += 1
  }
}

export function resolveClassValue(val) {
  if (!val && val !== 0) return ''
  if (typeof val === 'string') return val.trim()
  if (Array.isArray(val)) return val.map(resolveClassValue).filter(Boolean).join(' ')
  if (typeof val === 'object') {
    return Object.entries(val)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k.trim())
      .join(' ')
  }
  return ''
}
