# Contributing to repo2prompt

Thank you for your interest in contributing to **repo2prompt**! Bug reports, improvements, and new features are all welcome. Below are some guidelines to help streamline the process:

## 1. Reporting a Bug

1. First, check if a similar issue already exists in the [Issues](https://github.com/Xavier4492/repo2prompt/issues).
2. If not, open a new issue and describe:

   - The expected and actual behavior.
   - Steps to reproduce the problem.
   - The package version (`npm list repo2prompt`) and your environment (Node.js version, OS).

## 2. Proposing a Fix or New Feature

1. **Fork** the repository and create a new branch from `main`:

   ```bash
   git checkout -b feature/my-feature
   ```

2. Follow the existing code style (TypeScript + ESLint + Prettier).

3. Add unit tests under `tests/` using Vitest:

   ```bash
   npm run test
   ```

4. Update the **Changelog** (`CHANGELOG.md`) using [Conventional Commits](https://www.conventionalcommits.org/):

   ```bash
   # Example commit
   feat: add support for localization
   ```

5. Submit a **Pull Request** targeting the `develop` or `main` branch, depending on the scope of the change.

## 3. Review Process

- Maintainers will review your PR and may request changes (e.g., style, tests, documentation).
- Once approved, your contribution will be merged and included in the next automated release via GitHub Actions + Semantic Release.

## 4. Code of Conduct

Please follow the [GitHub Code of Conduct](https://opensource.guide/code-of-conduct/) and maintain respectful and constructive communication.

---

Thanks again for your contribution! 🙏
