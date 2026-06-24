import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-codemirror": [
            "codemirror",
            "@codemirror/lang-yaml",
            "@codemirror/language",
            "@codemirror/search",
            "@codemirror/state",
            "@codemirror/view",
            "@lezer/highlight",
          ],
          "vendor-xterm": ["@xterm/xterm", "@xterm/addon-fit"],
          "vendor-tauri": ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
  },
});
