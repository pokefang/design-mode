import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import designMode from 'claude-design-mode/vite'

export default defineConfig({
  plugins: [designMode(), react(), tailwindcss()],
  server: {
    port: 3800,
    strictPort: true,
  },
})
