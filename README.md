# Ludusavi Manifest
The Ludusavi Manifest format is a YAML structure for defining
the location of game save data and other files that are of interest to back up.
Although this project was started for use by [Ludusavi](https://github.com/mtkennerly/ludusavi),
the goal is for the manifest format to be generic enough for any game backup tool to implement,
while leaving room for new fields and functionality over time.

This repository contains the [primary manifest](data/manifest.yaml),
which is compiled from data on [PCGamingWiki](https://www.pcgamingwiki.com/wiki/Home),
along with accessing the Steam API for game installation directory names.
If you find any data that is missing or incorrect, please contribute to the wiki,
and such changes will be incorporated into the primary manifest periodically.
There is also a list of [games without any info on what to back up](data/missing.md),
as well as [articles with wikitext that failed to parse](data/wiki-malformed.md).

Game developers may include a secondary manifest (named `.ludusavi.yaml`) with their games,
so that backup tools can automatically detect and use it
to discover what files need to be backed up for save data and configuration.

## Format
For the schema, refer to [schema.yaml](data/schema.yaml).
Note that the primary manifest is validated with [schema.strict.yaml](data/schema.strict.yaml),
which additionally specifies enums for some fields.
However, tools should implement [schema.yaml](data/schema.yaml),
so that new values in the manifest do not break older tools.

Here is an example:

```yaml
An Example Game:
  files:
    <base>/saves:
      tags:
        - save
    <base>/settings.json:
      when:
        - os: windows
        - os: linux
      tags:
        - config
    <base>/other:
      when:
        - os: mac
          store: steam
  installDir:
    AnExampleGame: {}
  registry:
    HKEY_CURRENT_USER/Software/An Example Game:
      tags:
        - save
        - config
  steam:
    id: 123
```

This means:

* `<base>/saves` will be backed up on any system.
* `<base>/settings.json` will be backed up if you're using Windows or Linux.
* `<base>/other` will be backed up if you're using Mac and Steam.
* On Windows, the registry key `HKEY_CURRENT_USER/Software/An Example Game` will be backed up.

Paths in the `files` section can include these placeholders:

| placeholder         | meaning                                                                                |
|---------------------|----------------------------------------------------------------------------------------|
| `<root>`            | a directory where games are installed (configured in backup tool)                      |
| `<game>`            | an `installDir` (if defined) or the game's canonical name in the manifest              |
| `<base>`            | shorthand for `<root>/<game>` (unless overridden by store-specific rules)              |
| `<home>`            | current user's home directory in the OS (`~`)                                          |
| `<storeUserId>`     | current user's ID in the game store                                                    |
| `<osUserName>`      | current user's name in the OS                                                          |
| `<winAppData>`      | `%APPDATA%` on Windows                                                                 |
| `<winLocalAppData>` | `%LOCALAPPDATA%` on Windows                                                            |
| `<winDocuments>`    | `<home>/Documents` (f.k.a. `<home>/My Documents`) or a localized equivalent on Windows |
| `<winPublic>`       | `%PUBLIC%` on Windows                                                                  |
| `<winProgramData>`  | `%PROGRAMDATA%` on Windows                                                             |
| `<winDir>`          | `%WINDIR%` on Windows                                                                  |
| `<xdgData>`         | `$XDG_DATA_HOME` on Linux                                                              |
| `<xdgConfig>`       | `$XDG_CONFIG_HOME` on Linux                                                            |

## Implementation
Tools must implement the following in addition to respecting the schema:

* For paths, first substitute the placeholders, then evaluate as a glob.
  Because of treating paths as globs, a path may match multiple files or directories.
* When a path identifies a folder,
  the backup includes all of its files and subdirectories recursively.
* When backing up registry keys, the backup includes all sub-keys recursively.
* If a tool supports secondary manifests, they must be automatically detected
  when they are named `.ludusavi.yaml` and located directly in `<base>`.
  For example, a Steam game's secondary manifest would be `<root>/steamapps/common/<game>/.ludusavi.yaml`.

Tools may also:

* Use store-specific logic to determine the `<base>`.
  For example, with Steam, if the root is `~/.steam/steam`,
  then `<base>` would be `<root>/steamapps/common/<game>`.
  Or a tool could use `<root>/**/<game>` as a generic option,
  although it could lead to wasted search time.
* Check possible save data locations even if the entry has inapplicable constraints.
  For example, if a file entry is marked as `os: windows`,
  then ideally a tool should only need to check that entry when running on Windows;
  however, it is a reality of the data set that it may simply be the only confirmed occurrence of the file,
  and it may in fact occur on other operating systems as well.
* Reject/ignore recursive aliases or set a recursion limit.
  The primary manifest will never contain a recursive alias.
* Reject/ignore relative paths in the `files` mapping
  (i.e., paths starting with `./` or `../`).
  The primary manifest will never contain relative paths.

For authors of secondary manifests bundled with games:

* If present, the secondary manifest must be located directly in the game's install folder (not a subfolder),
  and the file name must be `.ludusavi.yaml`.
* You must use `<base>` instead of relative paths.
  For example, use `<base>/save.dat` instead of `./save.dat`,
  and use `<base>/../parent` instead of `../parent`.

The latest version of the primary manifest can be downloaded from
https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml .
To check for updates:

* Store the value of the `ETag` header for the last downloaded version.
* Send a GET request to the URL with the `If-None-Match` header set to the last known `ETag` value.
* If the response code is 304, then no update is needed.
* If the response code is 200, then store the new `ETag` value.

## Development
Please refer to [CONTRIBUTING.md](CONTRIBUTING.md).
