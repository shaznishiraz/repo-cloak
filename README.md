# repo-cloak

🎭 Selectively extract and anonymize files from repositories. Perfect for sharing code with AI agents without exposing proprietary details.

> v2 is a ground-up rewrite. The v1 source lives in [`archive/`](archive/).

## Install

```bash
npm install -g repo-cloak-cli
```

## Development

```bash
npm install
npm run build        # compile to dist/
npm run dev          # rebuild on change
npm test             # run tests
npm run lint         # eslint
npm run typecheck    # tsc
npm run format       # prettier
```

Run the local build with `node dist/cli.js`, or `npm link` to get `repo-cloak` / `cloak` on your PATH.

## License

MIT
