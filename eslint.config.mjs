import css from "@eslint/css";
import {defineConfig} from "eslint/config";
import globals from "globals";
import {flatConfigs as importX} from "eslint-plugin-import-x";
import js from "@eslint/js";
import markdown from "@eslint/markdown";
import stylistic from "@stylistic/eslint-plugin";

export default defineConfig([
    {
        "files": ["**/*.css"],
        "plugins": {css},
        "language": "css/css",
        "extends": ["css/recommended"],
        "rules": {
            "css/no-invalid-properties": "off"
        }
    },
    {
        "files": [
            "**/*.js",
            "**/*.mjs"
        ],
        "languageOptions": {
            "ecmaVersion": "latest",
            "globals": {
                ...globals.browser,
                ...globals.node,
                "Log": "readonly",
                "Module": "readonly"
            }
        },
        "plugins": {js,
            stylistic},
        "extends": [
            importX.recommended,
            "js/all",
            "stylistic/all"
        ]
    },
    {"files": ["**/*.md"],
        "plugins": {markdown},
        "language": "markdown/gfm",
        "extends": ["markdown/recommended"]}
]);
