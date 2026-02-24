/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    browser: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended",
    "turbo", // Рекомендованная конфигурация от Turborepo
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  ignorePatterns: ["dist", "node_modules", ".next", ".turbo"], // Игнорировать скомпилированные файлы и зависимости
  rules: {
    // Здесь можно добавить или переопределить правила ESLint
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }], // Предупреждение о неиспользуемых переменных
    "@typescript-eslint/explicit-module-boundary-types": "off", // Отключить требование явных типов для экспортируемых функций
    "@typescript-eslint/no-explicit-any": "off", // Отключить запрет на 'any'
  },
};