# Example configurations

Copy one of these files to `~/.pi/agent/extensions/rail.json` for a global
profile or to `.pi/rail.json` in a trusted project.

Configuration is layered over Pi Rail's defaults. Omitted fields retain their
default values, and lists only append: a bare array adds entries to the
inherited list, and `{"add": [...], "remove": [...]}` also drops inherited
entries by name (see "Lists only append" in the main README). Nothing a lower
layer set disappears unless a file says so explicitly.

So each profile says what it changes, not the whole list. `network-allowlist.json`
adds `registry.npmjs.org` and removes the container-registry defaults it does
not want; `offline-restricted.json` removes every default network domain and
the package-cache write roots, and adds `.git` to `denyWrite`. The temp
directory roots stay writable in every profile: one of them is the platform
temp directory, which a file cannot name portably.

- `classifier-focused.json` disables filesystem and network restrictions,
  leaving tool actions to classifier review and command rules (environment
  scrubbing keeps its defaults). The Seatbelt backend still wraps shell processes.
- `balanced.json` keeps the default filesystem and network restrictions and
  adds fail-closed classifier review.
- `offline-restricted.json` permits writes only in the project and temporary
  directories, blocks all networking, retains sensitive-path denies (plus
  `.git`), and adds fail-closed classifier review.
- `network-allowlist.json` disables filesystem restrictions and permits network
  access only to the GitHub defaults plus `registry.npmjs.org`. It is the
  explicit allowlist-only example.
- `filesystem-denylist.json` disables network restrictions and otherwise allows
  filesystem access except for the default sensitive paths. It is the explicit
  denylist-driven example; adding `"/"` to `allowWrite` supplies the sandbox
  runtime's broad writable root, while the default `denyWrite` carves
  sensitive paths back out.
- `dispositions-deny-by-default.json` disables file/network restrictions, then
  routes every capability class to `deny` except
  reading the project and running its dev tools. It is the strict
  deny-by-default disposition profile.
- `dispositions-allow-by-default.json` also leans entirely on the disposition
  table, but allows ordinary local coding work and denies a concrete set of
  dangerous classes: credentials, local destruction, persistence, system
  modification, and off-machine effects.
- `commands-classify.json` keeps the default restrictions and adds two custom
  capability classes plus `commands.classify` rules that route `kubectl`,
  `helm`, and `terraform` into them deterministically — no naming call, and no
  waiting for a model to happen to use the class you defined. `terraform apply`
  is mapped to the built-in `off-machine-effects` rather than to a custom
  class, which shows the same list re-pointing a command at a stricter built-in.
  It also shows the most-specific-rule-wins ordering (`helm version *` →
  `read-system` carves the local version probe out of the broad `helm *` →
  `k8s-ops`, whichever is listed first), `flags` allowlists (`git worktree remove *`
  with `"flags": []` stays out of reach of `--force` and its abbreviations;
  `git cat-file *` is allowed only with its read-only flags), and a class that
  `extends` `local-destructive`, so read-only mode still denies it.

`network.enabled` means “enforce network restrictions.” With it set to `false`,
networking is unrestricted. To deny all networking, set it to `true` and
remove every inherited `allowedDomains` entry, as `offline-restricted.json`
does.

The sandbox runtime's domain policy is allowlist-based, so a network
denylist-only policy is not supported. Its write policy also requires at least
one writable root; use `"/"` as that root only when you intentionally want the
denylist-driven behavior shown in `filesystem-denylist.json`.

The two `dispositions-*.json` profiles intentionally remove deterministic
file/network boundaries. Their policy is the capability disposition table: a
model names each action with capability classes and the table decides. Treat
them as semantic review policy, not a hard sandbox.
