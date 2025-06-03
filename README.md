# repo2prompt

<!-- TODO: add all command option overwritable by the CLI, `.repo2prompt.json`, `package.json` field, and default values. -->
<!-- TODO: add support for, `.repo2prompt.js/cjs/ts`, `package.json` field, and default values. -->
<!-- -->
[![CI](https://github.com/Xavier4492/spur-monocle-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Xavier4492/spur-monocle-manager/actions/workflows/ci.yml)
[![Coverage Status](https://img.shields.io/endpoint?url=https://gist.github.com/Xavier4492/repo2prompt-coverage-badge)](https://github.com/Xavier4492/repo2prompt/actions/workflows/ci.yml)
[![Release](https://github.com/Xavier4492/spur-monocle-manager/actions/workflows/release.yml/badge.svg)](https://github.com/Xavier4492/spur-monocle-manager/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/spur-monocle-manager.svg)](https://www.npmjs.com/package/spur-monocle-manager)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Transform a Git repository into a structured text file, ready to be ingested by an LLM.
Generates a table of contents, includes every file (truncating if necessary), detects binary files, and handles ignore rules via a `.repo2promptignore` file.

---

## Table of Contents

1. [Description](#description)
2. [Features](#features)
3. [Installation](#installation)
4. [Usage](#usage)

   - [CLI Syntax](#cli-syntax)
   - [Available Options](#available-options)
   - [Examples](#examples)

5. [Configuration](#configuration)

   - [`.repo2prompt.json` File](#repo2promptjson-file)
   - [`repo2prompt` Field in `package.json`](#repo2prompt-field-in-packagejson)
   - [`.repo2promptignore` File](#repo2promptignore-file)

6. [Library API](#library-api)
7. [Tests & ci](#tests--ci)
8. [Contributing](#contributing)
9. [Changelog](#changelog)
10. [License](#license)

---

## Description

**repo2prompt** is a CLI utility (written in TypeScript) that transforms a Git repository into a single text file, structured to facilitate reading by an LLM (LLM‐friendly dump). It:

- Produces a **numbered table of contents**.
- Inserts each file with its content (or metadata if the file is binary).
- Truncates large files beyond a defined maximum size (with a `[TRUNCATED]` marker).
- Respects an ignore system (via a `.repo2promptignore`, similar to `.gitignore`), and allows re-inclusion via negative patterns.
- Offers configuration options from:

  1. CLI (`--config`, `--ignore`, `--output`, etc.)
  2. A `.repo2prompt.json` file
  3. A `repo2prompt` field in `package.json`

- Supports a “progress bar” mode (using `cli-progress`), which can be disabled.

The goal is to generate a single text file (`output.txt` by default) containing a “snapshot” slice of the repository, which you can provide to an LLM so it can analyze the entire project content.

---

## Features

- 🔍 **Binary Detection**: A file is considered binary either by the `.bin` extension or if it contains a null byte in its first 512 bytes.
- 📜 **Truncation**: Any text file exceeding `--max-size` (default 1 MiB) is truncated at the limit, followed by a `[TRUNCATED]` marker.
- 🚫 **Ignore Patterns**: Reads a `.repo2promptignore` (or a custom file via `--ignore`) to exclude files, with support for negative patterns (prefix `!`).
- 📋 **Table of Contents**: A numbered list of all included files (with their relative paths).
- ⚙️ **Flexible Configuration**:

  - CLI (`-c, --config`, `-i, --ignore`, `-o, --output`, `-m, --max-size`, `-d, --debug`, `--no-progress`)
  - JSON File (`.repo2prompt.json`)
  - `repo2prompt` Field in `package.json`

- 📑 **TypeScript Exports**: Besides the CLI, you can import the `main()` function into another project via `import { main } from 'repo2prompt'`.

---

## Installation

### Global (CLI)

```bash
npm install -g repo2prompt
```

Then the `repo2prompt` command is available in your PATH:

```bash
repo2prompt --help
```

### Local (Library)

In another project, to use the logic as a dependency:

```bash
npm install repo2prompt
```

Then in your scripts or a Node.js file:

```ts
import { main } from 'repo2prompt'
;(async () => {
  // Execute the CLI from your code (equivalent to `repo2prompt .`)
  await main()
})()
```

---

## Usage

### CLI Syntax

```bash
repo2prompt [repoPath] [options]
```

- **`repoPath`** (optional): Path to the repository to process (defaults to `.` for the current folder).
- **Options**:

  - `-c, --config <file>`: Path to a JSON configuration file (e.g., `.repo2prompt.json`).
  - `-p, --preamble <file>`: Path to a file to use as a preamble (replaces the default one).
  - `-o, --output <file>`: Output file name/path (default `output.txt`, or configured via `.repo2prompt.json`).
  - `-i, --ignore <file>`: Name of the ignore file (default `.repo2promptignore`, or configured).
  - `-m, --max-size <bytes>`: Maximum size in bytes to truncate a text file (default `1048576` = 1 MiB).
  - `-d, --debug`: Enables debug mode (detailed logs in the console).
  - `--no-progress`: Disables the progress bar.
  - `-v, --version`: Displays the package version.

### Available Options

| Option                   | Shortcut | Description                                           | Default Value                      |
| ------------------------ | -------- | ----------------------------------------------------- | ---------------------------------- |
| `repoPath`               | —        | Path to the repository to process                     | `.` (current directory)            |
| `-c, --config <file>`    | `-c`     | Path to a JSON configuration file (override)          | (checks for `.repo2prompt.json`) |
| `-p, --preamble <file>`  | `-p`     | Path to a file to use as a preamble                   | Predefined text in the code        |
| `-o, --output <file>`    | `-o`     | Path to the output file                               | `output.txt`                       |
| `-i, --ignore <file>`    | `-i`     | Name of the ignore file (considering `.repo2promptignore`) | `.repo2promptignore`                    |
| `-m, --max-size <bytes>` | `-m`     | Maximum size in bytes to truncate a text file         | `1048576` (1 MiB)                  |
| `-d, --debug`            | `-d`     | Enables verbose logging (debug mode)                  | `false`                            |
| `--no-progress`          | —        | Disables the progress bar                             | `false` (shows the progress bar)   |
| `-v, --version`          | `-v`     | Displays the package version                          | (version in `package.json`)        |

### Examples

1. **Simple Dump of the Current Repository**

   ```bash
   cd /path/to/myRepo
   repo2prompt
   # Generates `output.txt` in /path/to/myRepo
   ```

2. **Specify a Different Repository Path**

   ```bash
   repo2prompt ./example-project
   # Produces ./example-project/output.txt
   ```

3. **Use a JSON Configuration File**

   ```bash
   repo2prompt --config ./my-config.json ./example-project
   ```

4. **Change the Ignore File and Output File Names**

   ```bash
   repo2prompt --ignore .myignore --output dump.txt .
   ```

5. **Limit Max Size to 512 KiB and Disable the Progress Bar**

   ```bash
   repo2prompt --max-size 524288 --no-progress .
   ```

---

## Configuration

### `.repo2prompt.json` File

You can create a `.repo2prompt.json` file at the root of your repository:

```json
{
  "ignoreFile": ".repo2promptignore",
  "preamble": "preamble.prompt.txt",
  "output": "prompt.txt",
  "showProgress": true
}
```

- `ignoreFile`: Name/path of the ignore file (e.g., `.repo2promptignore`).
- `preamble`: Name/path to a text file to inject as a preamble (this file will be placed before the table of contents).
- `output`: Name/path of the generated output file (e.g., `prompt.txt`).
- `showProgress`: Boolean (`true`/`false`) to indicate whether to display the progress bar.

> **Configuration Priority**:
>
> 1. CLI (`--config`, `--ignore`, `--output`, `--preamble`, `--max-size`, `--no-progress`)
> 2. `.repo2prompt.json`
> 3. `repo2prompt` field in `package.json`
> 4. Default values hard-coded in `src/index.ts`

### `repo2prompt` Field in `package.json`

Alternatively, without creating a `.repo2prompt.json`, you can add a field in your `package.json`:

```jsonc
{
  // … other fields in package.json …
  "repo2prompt": {
    "ignoreFile": ".repo2promptignore",
    "preamble": "preamble.prompt.txt",
    "output": "prompt.txt",
    "showProgress": true,
  },
}
```

The expected keys are identical to those in `.repo2prompt.json`. This field will be read if you haven't passed `--config` via CLI and there is a valid `package.json` at the root.

### `.repo2promptignore` File

The `.repo2promptignore` file works like a combination of `.gitignore` and support for negative patterns. For example:

```bash
# Ignore all .log files
*.log

# Ignore a temporary folder
temp/**

# Explicitly re-include foo.txt
!foo.txt
```

- Empty lines or commented lines (`# …`) are ignored.
- Negative patterns (`!pattern`) re-include matching files after applying positive patterns.

---

## Library API

Beyond the CLI, you can import the `repo2prompt` module in a Node/TypeScript project and call the `main()` function directly. Example:

```ts
import { main, loadConfig, buildTableOfContents } from 'repo2prompt'

async function dumpMyRepo() {
  // Call the CLI “programmatically”
  await main()
}
```

---

## Tests & CI

- Unit tests & coverage via [Vitest](https://vitest.dev/)
- Linting & type-checking using ESLint + TypeScript
- Automated releases via GitHub Actions + [Semantic Release](https://semantic-release.gitbook.io/)

```bash
# Install dependencies
npm ci

# Run everything
npm run build        # Compile
npm run lint         # Lint
npm run type-check   # Type checking
npm run test:ci      # Tests + coverage

# Manual publishing (usually handled via GitHub Actions)
npm run release
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines, bug reports, and feature requests.

---

## Changelog

All notable changes to this project are recorded in the [CHANGELOG.md](CHANGELOG.md) file.

---

## License

This project is licensed under the **MIT** license. See [LICENSE](LICENSE) for more details.

---

> _2025 © Xavier Loué_ > [xavierloue@gmail.com](mailto:xavierloue@gmail.com) | [repo2prompt on GitHub](https://github.com/Xavier4492/repo2prompt)
