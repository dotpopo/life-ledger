import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 3100,
    open: false,
    // 允许局域网和隧道访问。cloudflared 的快速隧道域名每次都是随机生成的，
    // 所以用前导点做通配，不然每换一次隧道就要改一次配置。
    host: true,
    allowedHosts: ['travels-implies-finding-lawn.trycloudflare.com', '.trycloudflare.com'],
  },
});
