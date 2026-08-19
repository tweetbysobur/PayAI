// Next 16 ships eslint-config-next as native flat-config arrays, so we spread
// them directly. This avoids the @eslint/eslintrc FlatCompat layer, whose
// config validator throws "Converting circular structure to JSON" on the
// eslint-plugin-react config under ESLint 9 — which is why `npm run lint` was
// previously broken.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  { ignores: ["contracts/**", ".next/**", "node_modules/**", "test/stubs/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    // These are React-Compiler advisory rules (new in the React 19 hooks
    // plugin). They flag patterns that are only a concern under the compiler,
    // which this app doesn't use — keep them as warnings, not build-failing
    // errors, but still surface them.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",

      // Honor the `_` prefix this codebase already uses on deliberately
      // unused bindings — the no-op notifyExternal(_event)/(_ticket) seams
      // and `const { ok: _ok, ...data } = ...` discards. Those are
      // intentional and self-documenting; without this they read as dead
      // code and drown out the unused-variable warnings that are real.
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
];

export default eslintConfig;
