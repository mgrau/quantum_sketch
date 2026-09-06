import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import basicSsl from '@vitejs/plugin-basic-ssl'

// The drawing library lives next door as source. Alias its published subpaths
// straight at that source so the dev server transforms it with full HMR — no
// build step, edit misty_states and this reloads. (A real install would use
// the `file:../misty_states` dependency; the alias is the reliable dev path.)
const lib = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// `HTTPS=1 npm run dev` serves over self-signed TLS, which a phone on the LAN
// needs before the browser will hand out the clipboard image API.
const https = !!process.env.HTTPS

export default defineConfig({
  base: './', // served under a sub-path or inside a Canvas iframe
  plugins: https ? [basicSsl()] : [],
  resolve: {
    alias: {
      'misty-states/render': lib('../misty_states/src/core/index.ts'),
      'misty-states/kernel': lib('../misty_states/src/core/kernel.ts'),
      'misty-states/metadata': lib('../misty_states/src/core/metadata.ts'),
      'misty-states/encode': lib('../misty_states/src/core/render/encode.ts'),
      'misty-states': lib('../misty_states/src/core/api.ts'),
    },
  },
  server: {
    host: true, // reachable from a phone on the same network
    port: 5199, // other local dev servers occupy 5178/5180
    strictPort: true,
    fs: { allow: [lib('..')] }, // let Vite serve the sibling library source
  },
})
