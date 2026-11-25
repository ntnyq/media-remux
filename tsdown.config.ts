import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: {
    onlyBundle: ['@ntnyq/utils'],
  },
  dts: true,
  entry: ['src/index.ts', 'src/worker.ts'],
  platform: 'neutral',
})
