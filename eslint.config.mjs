import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.{ts,tsx}"];

export default [
  {
    ignores: [
      "node_modules/**",
      "output/**",
      "coverage/**",
      ".lark-remote-temp/**",
      ".metrics/**",
      ".screenshots/**",
      ".workbuddy/**",
      ".workbuddy-ai/**",
      ".wxt/**",
      ".chrome-e2e-profile/**",
      "target/**"
    ]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node
    }
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles
  })),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: reactHooks.configs.recommended.rules
  },
  {
    // 依赖方向在 lint 阶段拦：共享核心不认得任何站点目录，站点之间也不互相导入。
    // import.meta.glob 是构建期动态加载，不是静态 import，不受这条规则影响。
    files: ["src/core/**/*.{ts,tsx}", "src/sites/**/*.{ts,tsx}"],
    ignores: ["**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/sites/**", "**/bilibili/**", "**/youtube/**"],
              message: "共享核心与站点目录之间不能静态互相导入，数据形状走 core/plugin/types。"
            }
          ]
        }
      ]
    }
  }
];
