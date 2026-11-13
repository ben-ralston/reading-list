import nextPlugin from "eslint-config-next";

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "out/**", ".vercel/**"],
  },
  ...nextPlugin,
];

export default eslintConfig;
