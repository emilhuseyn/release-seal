import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// libauth instantiates its WASM hashes with top-level await, which needs an ES2022 target.
// base './' so the build works from a GitHub Pages project path.
export default defineConfig({
  plugins: [react()],
  base: './',
  // identity/ is a second page (BCH Nostr ID) sharing the wallet and chain code
  build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', identity: 'identity/index.html' } } },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
