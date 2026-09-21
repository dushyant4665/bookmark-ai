import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy keeps the browser talking to the same origin, so secrets and CORS
// stay a backend concern. Override the target with VITE_BACKEND_URL if needed.
export default defineConfig(() => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
}));
