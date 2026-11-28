# Qwen Code Docs Site

A documentation website for Qwen Code built with [Next.js](https://nextjs.org/) and [Nextra](https://nextra.site/).

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Setup Content

Prepare the public documentation content from the parent `docs` directory:

```bash
npm run link
```

The command links `docs/users/` and `docs/developers/` into `docs-site/content/`
and copies `docs/index.md` and `docs/_meta.ts`. Internal sections such as
`docs/design/` are outside the preview.

Edits under either linked directory are available without running the link
command again. After changing `docs/index.md` or `docs/_meta.ts`, run
`npm run link` again from `docs-site` to refresh the copies.

### Development

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the documentation site.

## Project Structure

```
docs-site/
├── src/
│   └── app/
│       ├── [[...mdxPath]]/    # Dynamic routing for MDX pages
│       │   └── page.jsx
│       └── layout.jsx          # Root layout with navbar and footer
├── mdx-components.js           # MDX component configuration
├── next.config.mjs             # Next.js configuration
└── package.json
```

## License

MIT © Qwen Team
