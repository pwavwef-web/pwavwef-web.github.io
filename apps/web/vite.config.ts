import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { publicSite, siteInputs } from './site/plugin';

/** Dev/preview servers route /embed/audio/{id} to the public player page, like the Hosting rewrite. */
function embedRoute(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url && /^\/embed\/audio\/[^/?#]+\/?(\?.*)?$/.test(req.url)) req.url = '/embed.html';
    next();
  };
  return {
    name: 'az-embed-route',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const project = env.VITE_FIREBASE_PROJECT_ID || 'demo-az-studio';
  // With the emulators, /api/public goes to the functions emulator (Hosting rewrites it in production).
  // VITE_PUBLIC_API_ORIGIN instead points it at a deployed site, so the player page can be worked on against
  // real published editions without a local export. Dev/preview only — it never reaches a build.
  const proxy = env.VITE_USE_EMULATORS === 'true' ? { '/api/public': { target: 'http://127.0.0.1:5001', rewrite: (p: string) => `/${project}/us-central1/azsPublic${p}` } } : env.VITE_PUBLIC_API_ORIGIN ? { '/api/public': { target: env.VITE_PUBLIC_API_ORIGIN, changeOrigin: true } } : undefined;
  return {
    plugins: [publicSite(), react(), tailwindcss(), embedRoute()],
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 5173, proxy },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        // The public player and the public website (static pages from site/) are their own small pages: they
        // share no code with the private studio, which is studio.html.
        input: { main: 'studio.html', embed: 'embed.html', ...siteInputs() },
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
  };
});
