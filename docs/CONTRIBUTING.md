# Contributing

Thank you for helping with Markasso. Bug fixes and refinements are welcome; for larger features, [open an issue](https://github.com/AlbertoBarrago/markasso/issues) first so we can agree on the approach.

## How to contribute

1. Fork the repository and create a branch from `main`: `git checkout -b feat/your-feature` (or `fix/`, `docs/`, `test/`, `chore/`)
2. Set up and run the app: see [AGENTS.md](../AGENTS.md) for the commands, the repository layout and the coding guidelines
3. Read [ARCHITECTURE.md](./ARCHITECTURE.md) for the data flow and the invariants
4. Make sure `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (the pre-commit hook runs them), and add tests for new behaviour
5. New UI text goes into all 8 locale files in `src/i18n/locales/`
6. Commit following [Conventional Commits](https://www.conventionalcommits.org/) and open a Pull Request against `main`

Please keep PRs focused: one feature or fix per PR.

## Commit convention

```
feat:     new feature
fix:      bug fix
refactor: code change with no behaviour change
chore:    tooling, dependencies, config
docs:     documentation only
style:    formatting, whitespace
test:     adding or updating tests
```

## Core team

| Name | Role | Contact |
|---|---|---|
| Alberto Barrago | Creator and maintainer | <albertobarrago@gmail.com> |
| Lorenzo Cataldi | Designer | <lorenzo@cataldi.design> |

## License

By contributing you agree that your changes are released under the project's [MIT License](../LICENSE).
