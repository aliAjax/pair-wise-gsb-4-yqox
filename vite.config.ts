import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 根 index.html 是独立静态页（License Lens），声线练习室 React 应用使用独立入口
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        soundLab: 'sound-lab.html',
      },
    },
  },
});
