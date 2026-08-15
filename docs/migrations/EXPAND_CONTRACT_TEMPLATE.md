# Expand/contract migration: <name>

## Compatibility matrix

| State                   | Old application reads/writes | New application reads/writes | Safe? |
| ----------------------- | ---------------------------- | ---------------------------- | ----- |
| Before expansion        |                              |                              |       |
| After expansion         |                              |                              |       |
| During backfill         |                              |                              |       |
| After read/write switch |                              |                              |       |
| After later contract    | not running                  |                              |       |

## Expansion release

- Migration files:
- Expected lock level and duration:
- Data/default behavior for old code:
- Staging row count and measured duration:
- Roll-forward recovery:

## Backfill

- Command:
- Batch size and pause:
- Resume cursor/checkpoint:
- Progress metric:
- Completion query:

## Contract release

- Earliest compatible application digest:
- Evidence no old digest can run:
- Backup/restore checkpoint:
- Reviewed destructive statement:
