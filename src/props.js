import { evalInContext } from './utils.js'

const SKIP_PROPS = new Set(['class', 'style', 'id', 'key'])

export function parsePropBindings(attrsRaw, context, runtime) {
  const props = {}
  const bindRe = /(?:x-bind:|:)([a-zA-Z_$][\w$]*)(?:\.[a-z]+)*\s*=\s*(["'])([\s\S]*?)\2/g
  let m = null
  while ((m = bindRe.exec(attrsRaw)) !== null) {
    const name = m[1]
    const expr = m[3]
    if (SKIP_PROPS.has(name)) continue
    if (name === 'component') continue
    try {
      props[name] = evalInContext(expr, context)
    } catch (error) {
      runtime.warn(
        `[bake-alpine-components] Could not evaluate prop :${name}="${expr}": ${error.message}`
      )
    }
  }
  return props
}

export function stripHostAttrs(attrsRaw) {
  return attrsRaw
    .replace(/\s*x-component(?:\.[a-z-]+)*\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s*x-component-styles\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s*styles\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(
      /\s*(?:x-bind:|:)(?!class\b|style\b|id\b)[a-zA-Z_$][\w$]*(?:\.[a-z]+)*\s*=\s*(["'])[\s\S]*?\1/gi,
      ''
    )
}

function escapeDoubleQuotedAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
}

export function mergeHostXData(attrs, propBindings) {
  const keys = Object.keys(propBindings)
  if (keys.length === 0) return attrs

  const propsJson = JSON.stringify(propBindings)
  const xDataRe = /\s*x-data\s*=\s*(["'])([\s\S]*?)\1/i
  const xDataMatch = attrs.match(xDataRe)

  if (!xDataMatch) {
    return `${attrs} x-data='${propsJson.replace(/'/g, '&#39;')}'`
  }

  const existingExpr = xDataMatch[2]
  const mergedExpr = `Object.assign({}, (${existingExpr}), ${propsJson})`
  return attrs.replace(xDataRe, ` x-data="${escapeDoubleQuotedAttr(mergedExpr)}"`)
}

export function stripServerDirectives(html) {
  return html
    .replace(/\s+x-component(?:\.[a-z-]+)*\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-component-styles\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+styles\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+s-text\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+s-html\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+s-class\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+s-style\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+s-show\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+s-bind:[a-zA-Z][a-zA-Z0-9-]*\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+s-if\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s*:key\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-slot\s*=\s*(["'])[\s\S]*?\1/gi, '')
    .replace(/\s+x-slot\b/gi, '')
}
