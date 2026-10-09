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
    // 所以只用前导点做通配，不写死某一个域名。
    host: true,
    allowedHosts: ['.trycloudflare.com'],
  },
});
