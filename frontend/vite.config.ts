import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// 백엔드 허용 Origin 목록에 맞춰 5173 포트를 고정합니다(docs/stage-5-api-guide.md).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@contracts': fileURLToPath(new URL('../docs/contracts/stage5/types.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 지연 로딩 페이지의 의존성도 개발 서버 시작 시 미리 번들링해, 처음 페이지를 열 때 전체 새로고침(토큰 소실)이 일어나지 않게 합니다.
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom', 'zustand', 'lucide-react', 'three', '@react-three/fiber', '@react-three/drei', '@xyflow/react', 'recharts'],
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          charts: ['recharts'],
          flow: ['@xyflow/react'],
        },
      },
    },
  },
});
