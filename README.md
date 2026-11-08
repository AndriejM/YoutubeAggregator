# YouTubeAggregator.chrome

A Chrome extension (Manifest V3) that injects a subscription-aggregator widget into the
left sidebar of youtube.com. Built with plain HTML, CSS and JavaScript — no external
dependencies, no bundler, no backend.

This project is an improved take on PocketTube; the reference (obfuscated) build used for
research is kept under `examples/` and is not part of the shipped extension.

## Status

Planning phase. See [PLAN.md](PLAN.md) for architecture, data model, milestones and
accepted decisions (document written in Russian).

## Planned core UI

- Widget in the YouTube sidebar, mounted inside the guide (`#guide-inner-content`).
- Header: profile selector (combobox) + configuration button.
- Channel list: avatar, channel title, count of new videos since the last visit.
- Configuration panel rendered inline in YouTube's main content area (`#content`).

## Target platform

Chrome (Manifest V3) only.

## Development phases

0. Skeleton extension and idempotent mount into the guide
1. Subscriptions list
2. Local profiles
3. New-video counters
4. Configuration panel
5. Robustness, localization, documentation

## License

TBD.
