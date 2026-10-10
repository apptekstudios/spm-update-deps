# Agent guide

The full recipe for using this CLI to find and apply Swift package updates is in
[.claude/skills/spm-update/SKILL.md](.claude/skills/spm-update/SKILL.md). In short:

```bash
spm-update check <path> --tsv --outdated        # what's outdated (cheapest output)
spm-update apply <path> Foo@minor Bar@2.0.0 -n  # preview decisions (-n = --dry-run)
spm-update apply <path> Foo@minor Bar@2.0.0     # write them (all-or-nothing)
```

To work on the tool itself, see [CLAUDE.md](CLAUDE.md).
