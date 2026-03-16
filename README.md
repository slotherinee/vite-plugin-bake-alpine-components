# vite-plugin-bake-alpine-components

A Vite plugin that bakes Alpine.js templates into static HTML at build time.

In development everything works dynamically through Alpine.js at runtime. During `vite build` the plugin "bakes" Alpine directives into fully static HTML — no runtime overhead, no JavaScript required for the rendered markup.

## Install

```bash
npm i -D vite-plugin-bake-alpine-components
```

## Usage

```js
// vite.config.js
import { defineConfig } from 'vite'
import bakeAlpine from 'vite-plugin-bake-alpine-components'

export default defineConfig({
  plugins: [bakeAlpine()],
})
```

### TypeScript

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import bakeAlpine from 'vite-plugin-bake-alpine-components'

export default defineConfig({
  plugins: [bakeAlpine({ strict: true })],
})
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `strict` | `boolean` | `true` | Abort the build on any bake failure. When `false`, failures are logged as warnings and original markup is kept. |
| `verbose` | `boolean` | `false` | Print detailed logs for each component render and `x-for` expansion. |
| `validateComponentPaths` | `boolean` | `true` | Verify that every `x-component.url` path points to an existing file before rendering. |

## Supported directives

### `x-for`

Loops are fully expanded at build time:

```html
<template x-for="item in $store.products.items" :key="item.id">
  <div x-text="item.title"></div>
</template>
```

Inside loops, `$index` is also available as a context variable.

### `x-text`

Values are evaluated and HTML-escaped:

```html
<h3 x-text="item.title"></h3>
<!-- becomes -->
<h3>My Product</h3>
```

### `x-component.url`

Loads and renders an HTML component file from `public/components/`:

```html
<div
  x-data="{ item: product }"
  x-component.url="'/components/product-card.html'"
></div>
```

### `x-slot`

Components support default and named slots:

```html
<!-- default slot -->
<div x-data="{ item }" x-component.url="'/components/card.html'">
  <template x-slot>
    <p>Slot content</p>
  </template>
</div>

<!-- named slot -->
<div x-data="{ item }" x-component.url="'/components/card.html'">
  <template x-slot="actions">
    <button>OK</button>
  </template>
</div>
```

Inside the component template, declare slots with standard `<slot>` elements:

```html
<template>
  <div class="card">
    <slot></slot>
    <footer><slot name="actions"></slot></footer>
  </div>
</template>
```

### Alpine Store (`$store.*`)

The plugin reads `Alpine.store(...)` definitions from `src/main.js` and makes them available during bake:

```js
// src/main.js
import Alpine from 'alpinejs'
import productsStore from './scripts/stores/productsStore.js'

Alpine.store('products', productsStore)
Alpine.start()
```

```html
<template x-for="item in $store.products.items">
  ...
</template>
```

Store files must use `export default`:

```js
// src/scripts/stores/productsStore.js
export default {
  items: [
    { id: 1, title: 'Widget', price: 9.99 },
    { id: 2, title: 'Gadget', price: 19.99 },
  ],
}
```

### Nested components

Components can include other components inside slots:

```html
<section x-data="{ item: outer }" x-component.url="'/components/wrapper.html'">
  <template x-slot>
    <div
      x-data="{ item: inner }"
      x-component.url="'/components/card.html'"
    ></div>
  </template>
</section>
```

## What is NOT baked

| Directive | Reason |
|---|---|
| `x-if` | Intentionally left as runtime — condition logic belongs in the browser |
| `x-html` | Security — raw HTML injection should remain a deliberate runtime choice |

## Multi-page support

Place additional pages in `src/pages/`:

```
src/pages/about/index.html
src/pages/blog/index.html
```

After build they are output to:

```
dist/pages/about/index.html
dist/pages/blog/index.html
```

The plugin also removes `dist/components` after the build since all component markup is already inlined.

## Troubleshooting

**`ReferenceError: ... is not defined` during build**

The expression in `x-for`, `x-text`, or `x-data` references a variable not available in the current bake context. Check that the store is registered in `src/main.js` and the name matches what you use in HTML.

**Bake error message format**

When something fails you get a structured message:

```
[bake-alpine-components] Error in x-for list
Expression: $store.products.items
Context keys: $store, item, $index
HTML: <template x-for="item in $store.products.items" ...
Original error: Cannot read properties of undefined
```

Set `strict: false` to downgrade errors to warnings and let the build continue.

## License

MIT
