// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "generated/**"],
  },
  ...tseslint.configs.recommended,
  {
    // Plain JS config files (this one, jest.config.js) sit outside
    // tsconfig.json's `src` and don't need type-aware linting.
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        // Only `no-floating-promises` below needs type information; everything
        // else in `recommended` is syntactic. Scoping the type-checked parser
        // to the handful of rules that need it keeps this close to the
        // "recommended + no-floating-promises + no-unused-vars" baseline the
        // issue asked for, rather than opting into the much stricter
        // `recommendedTypeChecked` preset's `no-unsafe-*` family.
        projectService: { allowDefaultProject: ["prisma/seed.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Express route handlers and the subscription executor's background
      // loop are the two places an un-awaited promise is a real bug: an
      // unhandled rejection that silently drops a request or a charge
      // failure instead of being caught and logged.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
