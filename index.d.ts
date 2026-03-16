import type { Plugin } from 'vite'

export interface BakeAlpineComponentsOptions {
  /**
   * Throw an error on any bake failure and abort the build.
   * When false, failures are logged as warnings and the original markup is kept.
   * @default true
   */
  strict?: boolean

  /**
   * Print detailed logs for each component render and x-for expansion.
   * @default false
   */
  verbose?: boolean

  /**
   * Verify that every x-component.url path points to an existing file before rendering.
   * @default true
   */
  validateComponentPaths?: boolean
}

export default function bakeAlpineComponentsPlugin(
  options?: BakeAlpineComponentsOptions
): Plugin
