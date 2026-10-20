import tseslint from "typescript-eslint";
export default tseslint.config(
  ...tseslint.configs.recommended,
  { ignores: ["dist/**", "node_modules/**"] },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // An empty catch must carry a comment explaining why swallowing is safe.
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The frozen characterization tests keep their explicit anys and bare
    // empty blocks; product code and scripts are held to both rules above.
    files: ["tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "no-empty": "off" },
  },
);
