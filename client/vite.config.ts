import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/leads': 'http://localhost:3000',
      '/campaigns': 'http://localhost:3000',
      '/scheduler': 'http://localhost:3000',
      '/integrations': 'http://localhost:3000',
      '/admin': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
      '/tenants': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000'
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 5173
  }
})
