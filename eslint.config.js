import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "off"
    }
  },
  {
    files: ["extensions/**/*.js"],
    languageOptions: {
      globals: {
        chrome: "readonly",
        document: "readonly",
        MutationObserver: "readonly",
        navigator: "readonly",
        window: "readonly",
        sessionStorage: "readonly",
        URL: "readonly",
        HTMLAnchorElement: "readonly"
      }
    }
  }
);
