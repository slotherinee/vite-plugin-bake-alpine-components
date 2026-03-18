import { findMatchingClosingTag, normalizeAttrs, parseMaybeQuoted, readAttr, resolveSourcePath, truncate } from './utils.js'
import {
  collectSlotTemplates,
  extractStyles,
  protectOnPageTemplates,
  resolveServerFor,
  resolveServerIf,
  resolveServerTagDirectives,
  restoreOnPageTemplates,
} from './serverDirectives.js'
import {
  mergeHostXData,
  parsePropBindings,
  stripHostAttrs,
  stripServerDirectives,
} from './props.js'

function filterRuntimeProps(html, propBindings) {
  const propNames = Object.keys(propBindings)
  if (propNames.length === 0) return {}

  const needed = new Set()
  const runtimeAttrRe = /\s(?:x-[\w:-]+|:[\w:-]+|@[\w.$:-]+)\s*=\s*(["'])([\s\S]*?)\1/g

  let match = null
  while ((match = runtimeAttrRe.exec(html)) !== null) {
    const expr = match[2]
    for (const name of propNames) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(expr)) {
        needed.add(name)
      }
    }
  }

  if (needed.size === 0) return {}
  return Object.fromEntries([...needed].map((name) => [name, propBindings[name]]))
}


export function renderComponentHosts(
  html,
  context,
  rootDir,
  runtime,
  stack,
  collectedStyles,
  seenStyles
) {
  const hostOpenRe =
    /<([a-z0-9-]+)([^>]*\bx-component(?:\.[a-z-]+)*\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)>/gi

  let output = ''
  let cursor = 0
  let match = null

  while ((match = hostOpenRe.exec(html)) !== null) {
    const tag = match[1]
    const attrsRaw = match[2]
    const openStart = match.index
    const openEnd = hostOpenRe.lastIndex
    const close = findMatchingClosingTag(html, tag, openEnd)

    if (!close) continue

    const full = html.slice(openStart, close.end)
    const inner = html.slice(openEnd, close.start)

    output += html.slice(cursor, openStart)

    const plainExpr = readAttr(attrsRaw, 'x-component')
    const urlExprMatch = attrsRaw.match(/x-component(?:\.[a-z-]+)+\s*=\s*(["'])([\s\S]*?)\1/i)
    const urlExpr = urlExprMatch ? urlExprMatch[2] : ''
    const isOnPage = !!plainExpr && !urlExpr
    const sourceExpr = plainExpr || urlExpr

    if (!sourceExpr) {
      const msg = '[bake-alpine-components] x-component host is missing a source expression'
      if (runtime.strict) throw new Error(`${msg}\nHTML: ${truncate(full)}`)
      runtime.warn(`${msg}\nHTML: ${truncate(full)}`)
      output += full
      cursor = close.end
      hostOpenRe.lastIndex = close.end
      continue
    }

    const componentPath = isOnPage
      ? parseMaybeQuoted(sourceExpr)
      : resolveSourcePath(rootDir, sourceExpr)

    if (!componentPath) {
      const msg = `[bake-alpine-components] Could not resolve component path: ${sourceExpr}`
      if (runtime.strict) throw new Error(msg)
      runtime.warn(msg)
      output += full
      cursor = close.end
      hostOpenRe.lastIndex = close.end
      continue
    }

    if (stack.has(componentPath)) {
      output += full
      cursor = close.end
      hostOpenRe.lastIndex = close.end
      continue
    }
    const nextStack = new Set(stack)
    nextStack.add(componentPath)

    const { props: propBindings, anyFailed } = parsePropBindings(attrsRaw, context, runtime)

    // If ALL prop bindings failed to evaluate, the component is inside a runtime loop
    // (e.g. x-for). Leave it as-is for alpine-rc to handle at runtime.
    if (anyFailed) {
      output += full
      cursor = close.end
      hostOpenRe.lastIndex = close.end
      continue
    }

    const propContext = { ...context, ...propBindings }
    const strippedHostAttrs = stripHostAttrs(attrsRaw)

    const componentHtml = propContext.__componentHTML__[componentPath] ?? ''
    if (!componentHtml) {
      const msg = `[bake-alpine-components] Component not found in cache: ${componentPath}`
      if (runtime.strict) throw new Error(`${msg}\nHTML: ${truncate(full)}`)
      runtime.warn(`${msg}\nHTML: ${truncate(full)}`)
      output += full
      cursor = close.end
      hostOpenRe.lastIndex = close.end
      continue
    }

    if (runtime.verbose) runtime.log(`[bake-alpine-components] render: ${componentPath}`)

    const slotMap = { default: '' }
    for (const slotTemplate of collectSlotTemplates(inner)) {
      const slotContent = renderAll(
        slotTemplate.content,
        propContext,
        rootDir,
        runtime,
        nextStack,
        collectedStyles,
        seenStyles
      )
      slotMap[slotTemplate.name] = stripServerDirectives(slotContent)
    }

    let rendered = renderAll(
      componentHtml,
      propContext,
      rootDir,
      runtime,
      nextStack,
      collectedStyles,
      seenStyles
    )

    rendered = extractStyles(rendered, collectedStyles, seenStyles)

    rendered = rendered.replace(
      /<slot\s+name\s*=\s*(["'])([\s\S]*?)\1\s*>([\s\S]*?)<\/slot>/gi,
      (_m, _q, name, fallback) => {
        const content = slotMap[(name || '').trim()]
        return content !== undefined && content !== '' ? content : fallback
      }
    )
    rendered = rendered.replace(/<slot\s*>([\s\S]*?)<\/slot>/gi, (_m, fallback) =>
      slotMap.default !== '' ? slotMap.default : fallback
    )
    rendered = rendered.replace(/<slot\s*\/\s*>/gi, slotMap.default ?? '')

    rendered = stripServerDirectives(rendered)

    const runtimeProps = filterRuntimeProps(rendered, propBindings)
    if (Object.keys(runtimeProps).length > 0) {
      output += `<${tag}${normalizeAttrs(mergeHostXData(strippedHostAttrs, runtimeProps))}>${rendered}</${tag}>`
    } else {
      output += rendered
    }
    cursor = close.end
    hostOpenRe.lastIndex = close.end
  }

  output += html.slice(cursor)
  return output
}

export function renderAll(html, context, rootDir, runtime, stack, collectedStyles, seenStyles) {
  const { masked, blocks } = protectOnPageTemplates(html)
  html = masked

  html = resolveServerFor(html, context, runtime, (inner, ctx) =>
    renderAll(inner, ctx, rootDir, runtime, stack, collectedStyles, seenStyles)
  )
  html = resolveServerIf(html, context, runtime)
  html = renderComponentHosts(html, context, rootDir, runtime, stack, collectedStyles, seenStyles)
  html = resolveServerTagDirectives(html, context, runtime)
  return restoreOnPageTemplates(html, blocks)
}
