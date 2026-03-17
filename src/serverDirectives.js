import {
  escapeHtml,
  evalInContext,
  evalInContextOrThrow,
  normalizeAttrs,
  resolveClassValue,
} from './utils.js'

export function extractStyles(html, collectedStyles, seenStyles) {
  return html.replace(/<style(\s[^>]*)?>[\s\S]*?<\/style>/gi, (match) => {
    const cssText = match
      .replace(/<style[^>]*>/, '')
      .replace(/<\/style>/, '')
      .trim()
    if (cssText && !seenStyles.has(cssText)) {
      seenStyles.add(cssText)
      collectedStyles.push(cssText)
    }
    return ''
  })
}

export function protectOnPageTemplates(html) {
  const blocks = []
  const openTemplateRe = /<template\b[^>]*\bid\s*=\s*(["'])[\s\S]*?\1[^>]*>/gi

  let masked = ''
  let cursor = 0
  let match = null

  while ((match = openTemplateRe.exec(html)) !== null) {
    const openStart = match.index
    const openEnd = openTemplateRe.lastIndex
    const closeStart = findTemplateCloseIndex(html, openEnd)
    if (closeStart === -1) continue

    const closeEnd = closeStart + '</template>'.length
    const block = html.slice(openStart, closeEnd)
    const token = `__ARC_ONPAGE_TEMPLATE_${blocks.length}__`
    blocks.push(block)

    masked += html.slice(cursor, openStart)
    masked += token

    cursor = closeEnd
    openTemplateRe.lastIndex = closeEnd
  }

  masked += html.slice(cursor)
  return { masked, blocks }
}

export function restoreOnPageTemplates(html, blocks) {
  return html.replace(/__ARC_ONPAGE_TEMPLATE_(\d+)__/g, (_m, index) => blocks[Number(index)] ?? '')
}

function findTagEndIndex(html, startIndex) {
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

function findTemplateCloseIndex(html, fromIndex) {
  const closeRe = /<\/template\s*>/gi
  let depth = 1
  let cursor = fromIndex

  while (cursor < html.length) {
    const nextOpen = html.indexOf('<template', cursor)
    closeRe.lastIndex = cursor
    const closeMatch = closeRe.exec(html)
    if (!closeMatch) return -1
    const nextClose = closeMatch.index

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1
      cursor = nextOpen + 9
      continue
    }

    depth -= 1
    if (depth === 0) return nextClose
    cursor = closeRe.lastIndex
  }

  return -1
}

export function collectSlotTemplates(html) {
  const slots = []
  let cursor = 0

  while (cursor < html.length) {
    const openIndex = html.indexOf('<template', cursor)
    if (openIndex === -1) break

    const openEnd = findTagEndIndex(html, openIndex)
    if (openEnd === -1) break

    const openTag = html.slice(openIndex, openEnd + 1)
    const slotMatch = openTag.match(/\bx-slot(?:\s*=\s*(["'])([\s\S]*?)\1)?/i)
    if (!slotMatch) {
      cursor = openEnd + 1
      continue
    }

    const closeIndex = findTemplateCloseIndex(html, openEnd + 1)
    if (closeIndex === -1) break

    const content = html.slice(openEnd + 1, closeIndex)
    const name = (slotMatch[2] || 'default').trim() || 'default'
    slots.push({ name, content })

    cursor = closeIndex + '</template>'.length
  }

  return slots
}

export function resolveServerFor(html, context, runtime, renderFn) {
  const sForRe = /<template\s+[^>]*s-for\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/template>/gi
  return html.replace(sForRe, (full, _q, forExpr, inner) => {
    const forMatch = forExpr.match(/^\s*([a-zA-Z_$][\w$]*)\s+in\s+([\s\S]+)$/)
    if (!forMatch) {
      const msg = `[bake-alpine-components] Invalid s-for expression: ${forExpr}`
      if (runtime.strict) throw new Error(msg)
      runtime.warn(msg)
      return full
    }
    const alias = forMatch[1]
    const list = evalInContextOrThrow(forMatch[2].trim(), context, runtime, {
      where: 's-for list',
      htmlSnippet: full,
    })
    if (!Array.isArray(list)) {
      const msg = `[bake-alpine-components] s-for expects an array, got ${typeof list}`
      if (runtime.strict) throw new Error(msg)
      runtime.warn(msg)
      return full
    }
    return list
      .map((item, index) => renderFn(inner, { ...context, [alias]: item, $index: index }))
      .join('')
  })
}

export function resolveServerIf(html, context, runtime) {
  return html.replace(
    /<template\s+[^>]*s-if\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/template>/gi,
    (full, _q, expr, inner) => {
      try {
        return Boolean(evalInContext(expr, context)) ? inner : ''
      } catch (err) {
        runtime.warn(`[bake-alpine-components] s-if error: ${expr} — ${err.message}`)
        return full
      }
    }
  )
}

export function resolveServerTagDirectives(html, context, runtime) {
  html = html.replace(
    /<([a-z0-9-]+)([^>]*?)\s+s-if\s*=\s*(["'])([\s\S]*?)\3([^>]*)>([\s\S]*?)<\/\1>/gi,
    (full, tag, before, _q, expr, after, inner) => {
      const keep = evalInContextOrThrow(expr, context, runtime, {
        where: 's-if',
        htmlSnippet: full,
      })
      if (!Boolean(keep)) return ''
      return `<${tag}${normalizeAttrs(before + after)}>${inner}</${tag}>`
    }
  )

  html = html.replace(
    /<([a-z0-9-]+)([^>]*?)\s+s-text\s*=\s*(["'])([\s\S]*?)\3([^>]*)>([\s\S]*?)<\/\1>/gi,
    (full, tag, before, _q, expr, after) => {
      const text = escapeHtml(
        evalInContextOrThrow(expr, context, runtime, { where: 's-text', htmlSnippet: full })
      )
      return `<${tag}${normalizeAttrs(before + after)}>${text}</${tag}>`
    }
  )

  html = html.replace(
    /<([a-z0-9-]+)([^>]*?)\s+s-html\s*=\s*(["'])([\s\S]*?)\3([^>]*)>([\s\S]*?)<\/\1>/gi,
    (full, tag, before, _q, expr, after) => {
      try {
        const content = String(evalInContext(expr, context) ?? '')
        return `<${tag}${normalizeAttrs(before + after)}>${content}</${tag}>`
      } catch {
        return full
      }
    }
  )

  html = html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (full, tag, attrs) => {
    let out = attrs
    let changed = false

    const sClassRe = /\s*s-class\s*=\s*(["'])([\s\S]*?)\1/
    const sClassMatch = out.match(sClassRe)
    if (sClassMatch) {
      try {
        const resolved = resolveClassValue(evalInContext(sClassMatch[2], context))
        out = out.replace(sClassRe, '')
        const staticClassRe = /\s*\bclass\s*=\s*(["'])([\s\S]*?)\1/
        const staticMatch = out.match(staticClassRe)
        if (staticMatch) {
          const combined = [staticMatch[2].trim(), resolved].filter(Boolean).join(' ')
          out = out.replace(staticClassRe, ` class="${combined}"`)
        } else if (resolved) {
          out = ` class="${resolved}"` + out
        }
        changed = true
      } catch {
        // leave untouched
      }
    }

    const sStyleRe = /\s*s-style\s*=\s*(["'])([\s\S]*?)\1/
    const sStyleMatch = out.match(sStyleRe)
    if (sStyleMatch) {
      try {
        const val = evalInContext(sStyleMatch[2], context)
        const resolved =
          typeof val === 'string'
            ? val.trim()
            : typeof val === 'object' && val !== null
              ? Object.entries(val)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('; ')
              : ''
        out = out.replace(sStyleRe, '')
        const staticStyleRe = /\s*\bstyle\s*=\s*(["'])([\s\S]*?)\1/
        const staticMatch = out.match(staticStyleRe)
        if (staticMatch) {
          const existing = staticMatch[2].trim().replace(/;\s*$/, '')
          out = out.replace(
            staticStyleRe,
            ` style="${[existing, resolved].filter(Boolean).join('; ')}"`
          )
        } else if (resolved) {
          out += ` style="${resolved}"`
        }
        changed = true
      } catch {
        // leave untouched
      }
    }

    const sShowRe = /\s*s-show\s*=\s*(["'])([\s\S]*?)\1/
    const sShowMatch = out.match(sShowRe)
    if (sShowMatch) {
      try {
        const visible = Boolean(evalInContext(sShowMatch[2], context))
        out = out.replace(sShowRe, '')
        if (!visible) {
          const staticStyleRe = /\s*\bstyle\s*=\s*(["'])([\s\S]*?)\1/
          const styleMatch = out.match(staticStyleRe)
          if (styleMatch) {
            out = out.replace(staticStyleRe, ` style="${styleMatch[2].trim()}; display: none;"`)
          } else {
            out += ' style="display: none;"'
          }
        }
        changed = true
      } catch {
        // leave untouched
      }
    }

    const sBindRe = /\s*s-bind:([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(["'])([\s\S]*?)\2/g
    out = out.replace(sBindRe, (m, attrName, _q, expr) => {
      try {
        const val = evalInContext(expr, context)
        if (val === false || val == null) {
          changed = true
          return ''
        }
        const serialized = typeof val === 'object' ? JSON.stringify(val) : String(val)
        changed = true
        return ` ${attrName}="${escapeHtml(serialized)}"`
      } catch {
        return m
      }
    })

    return changed ? `<${tag}${out}>` : full
  })

  return html
}
