import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: ['@ntnyq/utils'],
  },
  dts: true,
  entry: ['src/index.ts', 'src/worker.ts'],
  platform: 'neutral',
})
