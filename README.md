# spm-update-script

To install dependencies:

```bash
bun install
```

To run in dev:

```bash
bun run src/cli.ts [path]
```

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Standalone executable

Build a single-file executable with Bun:

```bash
bun run build
```

The binary will be at `dist/spm-update`.

## Usage

- Run on current working directory:

```bash
./dist/spm-update
```

- Run on a supplied path:

```bash
./dist/spm-update /path/to/dir
```
