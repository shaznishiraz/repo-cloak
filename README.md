# repo-cloak 🎭

> ⚠️ **ARCHIVED**: This CLI project is no longer actively maintained. All new development has moved to the official [Repo-Cloak VS Code Extension](https://github.com/iamshz97/repo-cloak-vs-code).

> **Selectively extract and anonymize files from repositories**

Create controlled, anonymized workspaces from enterprise codebases. Perfect for sharing code with AI agents without exposing proprietary details. Extract specific files, replace sensitive information, scan for secrets, and restore changes later.

[![npm version](https://img.shields.io/npm/v/repo-cloak-cli.svg)](https://www.npmjs.com/package/repo-cloak-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Features

- 🔍 **Interactive file browser** - Navigate and select files with a beautiful TUI
- 🎭 **Smart anonymization** - Replace sensitive keywords while preserving case (UPPER, lower, TitleCase)
- 📁 **Structure preservation** - Maintains original folder hierarchy, file names, and paths
- 🔄 **Push/Pull workflow** - Extract files, work on them, push back with original names
- 🔐 **Encrypted mappings** - AES-256 encrypted mapping file tied to a local secret key
- 🛡️ **Secret scanning** - Automatically detects API keys, tokens, credentials, and secrets before extraction
- 📂 **Git-aware selection** - Pull files from specific commits, recent history, or uncommitted changes
- 🤖 **AI agent context** - Auto-generates AGENTS.md in cloaked workspaces to guide AI assistants
- 🌍 **Cross-platform** - Works on Windows, macOS, and Linux

## 📦 Installation

```bash
npm install -g repo-cloak-cli
```

Or use directly with npx:

```bash
npx repo-cloak-cli
```

## 🚀 Quick Start

### Pull (Extract & Anonymize)

```bash
# Interactive mode
repo-cloak pull

# With options
repo-cloak pull --source ./my-project --dest ./extracted
```

1. Select files/folders to extract
2. Secret scanner checks for embedded credentials
3. Add keyword replacements (e.g., "Microsoft Corp" → "ACME Inc")
4. Confirm and extract!

### Pull from Git Commits

```bash
# Pull files changed in a specific commit
repo-cloak pull --commit a1b2c3d

# Pull files from multiple commits
repo-cloak pull --commit a1b2c3d e4f5g6h

# Browse and select from recent commits interactively
repo-cloak pull --list-commits 10
```

### Push (Restore)

```bash
# Interactive mode
repo-cloak push

# With options
repo-cloak push --source ./extracted --dest ./my-project
```

Restores all files with original keywords replaced back.

### Force Update

To quickly re-pull or re-push without interactive prompts (useful for scripts):

```bash
# Update existing cloaked directory from source
repo-cloak pull --force

# Restore cloaked files to original source
repo-cloak push --force
```

## 🎯 Use Cases

- **AI Code Review** - Share proprietary code with AI tools by anonymizing company/project names
- **Test Generation** - Expose interfaces and DTOs to AI for generating test coverage without revealing business logic
- **Open Source Templates** - Extract project templates while removing internal references
- **Code Samples** - Create sanitized examples from production code
- **Compliance** - Remove sensitive identifiers before sharing code externally

## 🛡️ Secret Scanning

Before any file leaves your repository, Repo-Cloak scans for **20+ categories** of sensitive data:

| Category               | Examples                                                        |
| ---------------------- | --------------------------------------------------------------- |
| Cloud Keys             | AWS Access Keys, Google API Keys, Azure tokens                  |
| Platform Tokens        | GitHub PATs, Slack tokens, Discord bot tokens                   |
| Payment Keys           | Stripe live & test keys                                         |
| Cryptographic Material | RSA, DSA, OpenSSH private keys                                  |
| Authentication         | JWTs, Bearer tokens, OAuth access tokens                        |
| Infrastructure         | Database connection strings (PostgreSQL, MongoDB, MySQL, Redis) |
| Credentials            | Passwords, secrets, and passphrase assignments                  |
| Service Keys           | Heroku, Mailgun, and other platform-specific keys               |

If secrets are detected, extraction halts with a warning showing exact file and line numbers. You must explicitly confirm before proceeding.

## 📋 Commands

| Command                           | Description                             |
| --------------------------------- | --------------------------------------- |
| `repo-cloak`                      | Interactive menu to choose pull or push |
| `repo-cloak pull`                 | Extract and anonymize files             |
| `repo-cloak pull --commit <hash>` | Pull files from specific commits        |
| `repo-cloak pull --list-commits`  | Select from recent commit history       |
| `repo-cloak push`                 | Restore files with original names       |
| `repo-cloak --help`               | Show help                               |
| `repo-cloak --version`            | Show version                            |

## 🔧 Options

### Pull Options

- `-s, --source <path>` - Source directory (default: current directory)
- `-d, --dest <path>` - Destination directory
- `-c, --commit <hash...>` - Pull files from specific commit(s)
- `-l, --list-commits [count]` - List and select from recent commits (default: 10)
- `-f, --force` - Force pull all files (skip prompts, requires existing mapping)
- `-q, --quiet` - Minimal output

### Push Options

- `-s, --source <path>` - Cloaked backup directory
- `-d, --dest <path>` - Destination directory
- `-f, --force` - Force push/restore all files (skip confirmation)
- `-q, --quiet` - Minimal output

## 📁 How It Works

1. **Pull** creates a `.repo-cloak-map.json` file in the destination that stores:
   - Original source path
   - All keyword replacements (encrypted with AES-256)
   - File list with path mappings
   - Pull history with timestamps

2. **Secret Scanner** runs automatically on all selected files before extraction, checking for API keys, tokens, credentials, private keys, and database connection strings.

3. **AGENTS.md** is auto-generated in the cloaked workspace to instruct AI agents about the partial, anonymized nature of the repository and guide their behavior.

4. **Push** reads the encrypted mapping file to:
   - Reverse all keyword replacements
   - Restore files to original or new location

## 🔒 Privacy by Design

- No data is sent to any external servers
- All processing happens locally on your machine
- Mapping files are AES-256 encrypted with locally generated keys
- Binary files are copied without modification
- Hidden files and common ignored directories (node_modules, .git) are skipped
- Secret scanning catches embedded credentials before extraction

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT © Shazni Shiraz

---

Made with ❤️ for developers who need to share code safely
