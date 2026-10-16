# Design docs

How repo-cloak v2 is built. Written **before** the code, kept in sync with it.
One file per topic; see [`../README.md`](../README.md) for the full index.

| Doc                            | Covers                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| [overview.md](overview.md)     | Big picture, interactive flow, modules, push, build order    |
| [data-model.md](data-model.md) | Every JSON file, schemas, encryption, regex and secret rules |
| [cli.md](cli.md)               | Commands, flags, exit codes                                  |
| [web-ui.md](web-ui.md)         | The local web UI                                             |

New design topics use the template below.

## Template

````markdown
# <Topic>

## Problem

What we need and why, in a few sentences.

## Design

```
+---------+      +-----------+      +--------+
|  input  | ---> |  process  | ---> | output |
+---------+      +-----------+      +--------+
```

Key types:

```ts
// the few types that define the shape of this feature
```

## Decisions

- Chose X over Y because ...

## Open questions

- ...
````
