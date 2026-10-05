import {defineConfig} from 'tsup'

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: 'esm',
  target: 'node18',
  clean: true,
  // gramjs is CJS and large; leave it for Node to load from node_modules
  external: ['teleproto'],
  banner: {js: '#!/usr/bin/env node'},
})
