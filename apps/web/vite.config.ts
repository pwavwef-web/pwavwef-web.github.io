import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173 },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache across app deploys.
        manualChunks(id: string) {
          if (/node_modules[\\/](firebase|@firebase)[\\/]/.test(id)) return 'vendor-firebase';
          if (/node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return 'vendor-react';
          if (/node_modules[\\/](radix-ui|@radix-ui|lucide-react|sonner|zustand)[\\/]/.test(id)) return 'vendor-ui';
          return undefined;
        },
      },
    },
  },
});
