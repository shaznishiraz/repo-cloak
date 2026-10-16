# Development Guide

This guide explains how to set up, run, and test `repo-cloak` locally during development.

## Prerequisites

Ensure you have Node.js (>=18.0.0) installed on your system.

## Setup

First, install the project dependencies:

```bash
npm install
```

## Running the CLI Locally

If you want to manually test the CLI functionality without installing it globally, you can execute the main bin file directly:

```bash
# Start the interactive menu
npm start

# Or run specific commands directly
node bin/repo-cloak.js pull
node bin/repo-cloak.js pull --source ./my-project --dest ./extracted
```

## Global Local Testing (Recommended)

To test how the CLI behaves globally on your machine (using the `repo-cloak` command anywhere), you can create a symlink from your global `node_modules` to your local project directory using `npm link`.

1. Run this inside the project folder (`repo-cloak`):

```bash
npm link
```

2. You can now open any other folder on your computer and test your local changes by simply running:

```bash
repo-cloak pull
```

3. When you are done testing and want to remove the symlink, run:

```bash
npm unlink -g repo-cloak-cli
```

## Running Tests

This project uses **Vitest** for unit testing.

To run the test suite once:

```bash
npm test
```

To run tests in watch mode (automatically re-runs when you save changes):

```bash
npm run test:watch
```

## Linting

To check for code style issues using ESLint:

```bash
npm run lint
```
