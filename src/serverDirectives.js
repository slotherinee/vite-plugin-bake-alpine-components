import {
  escapeHtml,
  evalInContext,
  evalInContextOrThrow,
  findMatchingClosingTag,
  findTagEndIndex,
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

function parseServerTemplates(html, directiveName, callback) {
  let output = ''
  let cursor = 0
  const directiveRe = new RegExp(`\\b${directiveName}\\s*=`, 'i')

  while (cursor < html.length) {
    // Find next <template
    const templateStart = html.indexOf('<template', cursor)
    if (templateStart === -1) break

    // Find end of opening tag — quote-aware, handles > inside attribute values
    const tagEnd = findTagEndIndex(html, templateStart + 9)
    if (tagEnd === -1) break

    const openTag = html.slice(templateStart, tagEnd + 1)
    const openEnd = tagEnd + 1

    if (!directiveRe.test(openTag)) {
      output += html.slice(cursor, openEnd)
      cursor = openEnd
      continue
    }

    const closeIndex = findTemplateCloseIndex(html, openEnd)
    if (closeIndex === -1) break

    const closeEnd = closeIndex + '</template>'.length
    const full = html.slice(templateStart, closeEnd)
    const inner = html.slice(openEnd, closeIndex)

    output += html.slice(cursor, templateStart)
    output += callback(full, openTag, inner)
    cursor = closeEnd
  }

  output += html.slice(cursor)
  return output
}

export function resolveServerFor(html, context, runtime, renderFn) {
  return parseServerTemplates(html, 's-for', (full, openTag, inner) => {
    const forMatch = openTag.match(/\bs-for\s*=\s*(["'])([\s\S]*?)\1/)
    if (!forMatch) return full
    const forExpr = forMatch[2]
    const aliasMatch = forExpr.match(/^\s*([a-zA-Z_$][\w$]*)\s+in\s+([\s\S]+)$/)
    if (!aliasMatch) {
      const msg = `[bake-alpine-components] Invalid s-for expression: ${forExpr}`
      if (runtime.strict) throw new Error(msg)
      runtime.warn(msg)
      return full
    }
    const alias = aliasMatch[1]
    const list = evalInContextOrThrow(aliasMatch[2].trim(), context, runtime, {
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
  return parseServerTemplates(html, 's-if', (full, openTag, inner) => {
    const ifMatch = openTag.match(/\bs-if\s*=\s*(["'])([\s\S]*?)\1/)
    if (!ifMatch) return full
    try {
      return Boolean(evalInContext(ifMatch[2], context)) ? inner : ''
    } catch (err) {
      runtime.warn(`[bake-alpine-components] s-if error: ${ifMatch[2]} — ${err.message}`)
      return full
    }
  })
}

function resolveElementDirective(html, directiveName, context, transform) {
  let output = ''
  let cursor = 0
  const tagOpenRe = /<([a-z0-9-]+)/gi
  const directiveRe = new RegExp(`\\s${directiveName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)

  while (cursor < html.length) {
    tagOpenRe.lastIndex = cursor
    const tagStart = tagOpenRe.exec(html)
    if (!tagStart) break

    const tag = tagStart[1]
    const openStart = tagStart.index
    const tagEnd = findTagEndIndex(html, tagOpenRe.lastIndex)

    if (tagEnd === -1) {
      output += html.slice(cursor, openStart + 1)
      cursor = openStart + 1
      continue
    }

    const openTag = html.slice(openStart, tagEnd + 1)
    const openEnd = tagEnd + 1
    const directiveMatch = openTag.match(directiveRe)

    if (!directiveMatch) {
      // No directive on this tag — consume just the `<` and continue scanning
      output += html.slice(cursor, openStart + 1)
      cursor = openStart + 1
      continue
    }

    const expr = directiveMatch[1] ?? directiveMatch[2]
    const attrsWithout = openTag.replace(directiveRe, '')

    const close = findMatchingClosingTag(html, tag, openEnd)
    if (!close) {
      output += html.slice(cursor, openStart + 1)
      cursor = openStart + 1
      continue
    }

    const inner = html.slice(openEnd, close.start)
    const full = html.slice(openStart, close.end)

    output += html.slice(cursor, openStart)
    output += transform(full, tag, attrsWithout, expr, inner)
    cursor = close.end
    tagOpenRe.lastIndex = cursor
  }

  output += html.slice(cursor)
  return output
}

export function resolveServerTagDirectives(html, context, runtime) {
  html = resolveElementDirective(html, 's-if', context, (full, tag, openTag, expr, inner) => {
    const keep = evalInContextOrThrow(expr, context, runtime, {
      where: 's-if',
      htmlSnippet: full,
    })
    if (!keep) return ''
    // openTag already has s-if stripped — extract attrs string from "<tag attrs>"
    const attrsStr = openTag.slice(tag.length + 1, -1)
    return `<${tag}${normalizeAttrs(attrsStr)}>${inner}</${tag}>`
  })

  html = resolveElementDirective(html, 's-text', context, (full, tag, openTag, expr) => {
    const text = escapeHtml(
      evalInContextOrThrow(expr, context, runtime, { where: 's-text', htmlSnippet: full })
    )
    const attrsStr = openTag.slice(tag.length + 1, -1)
    return `<${tag}${normalizeAttrs(attrsStr)}>${text}</${tag}>`
  })

  html = resolveElementDirective(html, 's-html', context, (full, tag, openTag, expr) => {
    try {
      const content = String(evalInContext(expr, context) ?? '')
      const attrsStr = openTag.slice(tag.length + 1, -1)
      return `<${tag}${normalizeAttrs(attrsStr)}>${content}</${tag}>`
    } catch {
      return full
    }
  })

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
      if (attrName === 'x-data') {
        throw new Error(
          `[bake-alpine-components] s-bind:x-data is not allowed. Use x-data directly — props are available in scope via the host wrapper.\n  Expression: ${expr}`
        )
      }
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
