import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      react(), tailwindcss(),
      {
        name: 'pulse-content-security-policy',
        transformIndexHtml(html) {
          const script = mode === 'development' ? "'self' 'unsafe-inline'" : "'self'"
          const connect = mode === 'development' ? "'self' ws: wss:" : "'none'"
          const policy = `default-src 'none'; img-src 'self' data: https: blob:; style-src 'self' 'unsafe-inline'; script-src ${script}; connect-src ${connect}; font-src 'self'; base-uri 'none'; frame-src 'none'; form-action 'none'; object-src 'none'`
          return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${policy}" />`)
        }
      }
    ],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
}))
