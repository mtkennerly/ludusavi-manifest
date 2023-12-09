## Development
Use the latest version of Rust and Python.

Generally, you just need these commands:

* Install script dependencies (one time):
  * `pip install "steam[client]"`
* Add all recent changes (defaults to last day, but then it remembers when you last ran it):
  * `cargo run -- bulk --recent-changes`
* List some stats about the data set:
  * `cargo run -- stats`
* Activate pre-commit hooks (requires Python):
  ```
  pip install --user pre-commit
  pre-commit install
  ```

There are some lower-level commands for finer control or full imports:

* Add new games to wiki-game-cache.yaml (required in order to add them to the manifest):
  * `cargo run -- bulk --missing-pages`
* Validate schema:
  * `cargo run -- schema`

## API etiquette
When running or modifying the importer script,
please be mindful not to unnecessarily spam the PCGW or Steam APIs.

The [Mediawiki guidelines](https://www.mediawiki.org/wiki/API:Etiquette)
suggest that:

> Making your requests in series rather than in parallel,
> by waiting for one request to finish before sending a new request,
> should result in a safe request rate.

I am not sure about guidelines for the Steam API,
but the cache file should mean that we are not making excessive requests.
