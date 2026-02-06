# repo-cloak 🎭

> **Selectively extract and anonymize files from repositories**

Perfect for sharing code with AI agents without exposing proprietary details. Extract specific files, replace sensitive information (company names, project names, etc.), and restore them later.

[![npm version](https://img.shields.io/npm/v/repo-cloak.svg)](https://www.npmjs.com/package/repo-cloak)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Features

- 🔍 **Interactive file browser** - Navigate and select files with a beautiful TUI
- 🎭 **Smart anonymization** - Replace sensitive keywords while preserving case
- 📁 **Structure preservation** - Maintains original folder hierarchy
- 🔄 **Push/Pull workflow** - Extract files, work on them, push back with original names
- 💾 **Mapping file** - Tracks all replacements for seamless restoration
- 🌍 **Cross-platform** - Works on Windows, macOS, and Linux

## 📦 Installation

```bash
npm install -g repo-cloak
```

Or use directly with npx:

```bash
npx repo-cloak
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
2. Enter destination path
3. Add keyword replacements (e.g., "Microsoft Corp" → "ACME Inc")
4. Confirm and extract!

### Push (Restore)

```bash
# Interactive mode
repo-cloak push

# With options
repo-cloak push --source ./extracted --dest ./my-project
```

Restores all files with original keywords replaced back.

## 🎯 Use Cases

- **AI Code Review** - Share proprietary code with AI tools by anonymizing company/project names
- **Open Source Templates** - Extract project templates while removing internal references
- **Code Samples** - Create sanitized examples from production code
- **Compliance** - Remove sensitive identifiers before sharing code externally

## 📋 Commands

| Command | Description |
|---------|-------------|
| `repo-cloak` | Interactive menu to choose pull or push |
| `repo-cloak pull` | Extract and anonymize files |
| `repo-cloak push` | Restore files with original names |
| `repo-cloak --help` | Show help |
| `repo-cloak --version` | Show version |

## 🔧 Options

### Pull Options
- `-s, --source <path>` - Source directory (default: current directory)
- `-d, --dest <path>` - Destination directory
- `-q, --quiet` - Minimal output

### Push Options
- `-s, --source <path>` - Cloaked backup directory
- `-d, --dest <path>` - Destination directory
- `-q, --quiet` - Minimal output

## 📁 How It Works

1. **Pull** creates a `.repo-cloak-map.json` file in the destination that stores:
   - Original source path
   - All keyword replacements
   - File list with mappings
   - Timestamp

2. **Push** reads this mapping file to:
   - Reverse all keyword replacements
   - Restore files to original or new location

## 🔒 Privacy by Design

- No data is sent to any external servers
- All processing happens locally
- Binary files are copied without modification
- Hidden files and common ignored directories (node_modules, .git) are skipped

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT © Shazni Shiraz

---

Made with ❤️ for developers who need to share code safely
