import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import stylistic from "@stylistic/eslint-plugin";
import importRules from "eslint-plugin-import";

const plugins = {
	"@stylistic": stylistic,
	"@typescript-eslint": typescriptEslint,
	import: importRules,
};

export const baseRules = {
	"@typescript-eslint/no-unused-vars": [
		2,
		{args: "none", caughtErrors: "none"},
	],

	/**
	 * Enforced rules
	 */
	// syntax preferences
	"object-curly-spacing": ["error", "always"],
	quotes: [
		2,
		"double",
		{
			avoidEscape: true,
			allowTemplateLiterals: true,
		},
	],
	"jsx-quotes": [2, "prefer-single"],
	"no-extra-semi": 2,
	"@stylistic/semi": [2],
	"comma-style": [2, "last"],
	"wrap-iife": [2, "inside"],
	"spaced-comment": [
		2,
		"always",
		{
			markers: ["*"],
		},
	],
	eqeqeq: [2],
	"accessor-pairs": [
		2,
		{
			getWithoutSet: false,
			setWithoutGet: false,
		},
	],
	"brace-style": [2, "1tbs", {allowSingleLine: true}],
	curly: [2, "all"],
	"new-parens": 2,
	"arrow-parens": [2, "as-needed"],
	"prefer-const": 2,
	"quote-props": [2, "consistent"],
	"nonblock-statement-body-position": [2, "below"],

	// anti-patterns
	"no-var": 2,
	"no-with": 2,
	"no-multi-str": 2,
	"no-caller": 2,
	"no-implied-eval": 2,
	"no-labels": 2,
	"no-new-object": 2,
	"no-octal-escape": 2,
	"no-self-compare": 2,
	"no-shadow-restricted-names": 2,
	"no-cond-assign": 2,
	"no-debugger": 2,
	"no-dupe-keys": 2,
	"no-duplicate-case": 2,
	"no-empty-character-class": 2,
	"no-unreachable": 2,
	"no-unsafe-negation": 2,
	radix: 2,
	"valid-typeof": 2,
	"no-implicit-globals": [2],
	"no-unused-expressions": [
		2,
		{allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true},
	],
	"no-proto": 2,

	// es2015 features
	"require-yield": 2,
	"template-curly-spacing": [2, "never"],

	// spacing details
	"space-infix-ops": 2,
	"space-in-parens": [2, "never"],
	"array-bracket-spacing": [2, "never"],
	"comma-spacing": [2, {before: false, after: true}],
	"keyword-spacing": [2, "always"],
	"space-before-function-paren": [
		2,
		{
			anonymous: "never",
			named: "never",
			asyncArrow: "always",
		},
	],
	"no-whitespace-before-property": 2,
	"keyword-spacing": [
		2,
		{
			overrides: {
				if: {after: true},
				else: {after: true},
				for: {after: true},
				while: {after: true},
				do: {after: true},
				switch: {after: true},
				return: {after: true},
			},
		},
	],
	"arrow-spacing": [
		2,
		{
			after: true,
			before: true,
		},
	],
	"@stylistic/func-call-spacing": 2,
	"@stylistic/type-annotation-spacing": 2,

	// file whitespace
	"no-multiple-empty-lines": [2, {max: 2, maxEOF: 0}],
	"no-mixed-spaces-and-tabs": 2,
	"no-trailing-spaces": 2,
	"linebreak-style": [process.platform === "win32" ? 0 : 2, "unix"],
	indent: [
		2,
		"tab",
		{SwitchCase: 1, CallExpression: {arguments: "first"}, MemberExpression: 1},
	],
	"key-spacing": [
		2,
		{
			beforeColon: false,
		},
	],
	"eol-last": 2,
};

const languageOptions = {
	parser: tsParser,
	ecmaVersion: 9,
	sourceType: "module",
};

export default [
	{
		files: ["**/*.ts"],
		plugins,
		languageOptions,
		rules: baseRules,
	},
];
