import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: true,
      include: ["src"]
    })
  ],
  build: {
    lib: {
      entry: { index: resolve(__dirname, "src/index.ts"), "resource-leveler": resolve(__dirname, "src/resource-leveler.ts") },
      name: "JanttCore",
      formats: ["es", "cjs"],
      fileName: (format, entryName) => `${entryName}.${format === "es" ? "js" : "cjs"}`
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "style.css") return "theme.css";
          return assetInfo.name || "asset";
        }
      }
    }
  },
  test: {
    globals: true,
    environment: "jsdom"
  }
});
