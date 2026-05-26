# Rsync Folders for Obsidian

Desktop-only Obsidian plugin that synchronizes selected vault folders with paths on a remote server using `rsync` over SSH.

## What it does

- Stores global SSH/rsync settings: server, user, port, key path, rsync binary, extra arguments.
- Lets you add multiple mappings for folder contents or exact paths such as a single symlink.
- Supports per-folder direction:
  - `Push`: local vault folder to remote server.
  - `Pull`: remote server folder to local vault.
  - `Two way`: pull first, then push. This is convenient, but it is not real conflict resolution.
- Provides Command Palette actions:
  - `Rsync Folders: Sync all mappings`
  - `Rsync Folders: Push all mappings`
  - `Rsync Folders: Pull all mappings`
- Shows the last rsync output in a modal.

## Symlinks

By default, mappings use `Folder contents`. The plugin adds a trailing slash to both sides, so rsync synchronizes the contents of that folder.

To synchronize one symlink as the symlink itself, set the mapping path type to `Exact path / symlink`. In that mode the plugin does not add a trailing slash:

```text
Local vault path: Links/ClientA
Remote path: /srv/notes/Links/ClientA
Path type: Exact path / symlink
```

With the default `-a` rsync argument, symlinks are preserved as symlinks. Do not add `-L` or `--copy-links` unless you want rsync to copy the linked content instead.

## Development

```bash
npm install
npm run build
```

## Installation for multiple vaults

Do not install this plugin into multiple vaults by symlinking every vault to one shared working directory. Obsidian stores plugin settings in `data.json` inside each plugin folder, so shared symlinks also share settings.

For personal installs from GitHub, use [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Create a GitHub release for this repository.
2. In each vault, install and enable BRAT.
3. Use `BRAT: Add a beta plugin for testing`.
4. Paste the GitHub repository URL.
5. Enable `Rsync Folders` in Obsidian community plugins.

Each vault will then have its own physical plugin folder and its own `data.json`, while updates come from the same GitHub repository.

## Releases

Release artifacts are built by GitHub Actions when you push a tag:

```bash
npm version patch
git push
git push --tags
```

The release includes:

```text
manifest.json
main.js
styles.css
rsync-folders-<version>.zip
```

For one-off local testing, copy this folder into:

```text
<vault>/.obsidian/plugins/rsync-folders
```

Then enable the plugin in Obsidian settings.

## Safety notes

This plugin shells out to the local `rsync` binary and only works in the desktop app. Review your mappings carefully before using `--delete`; it can remove files at the destination.

For SSH key paths, use an absolute path such as:

```text
/Users/you/.ssh/id_ed25519
```

Remote paths can be absolute, for example:

```text
/srv/notes/projects
```

or relative to the configured remote base path.
