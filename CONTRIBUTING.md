## Development
Requires Node.js.

Generally, you just need these commands:

* Add all recent changes (defaults to last 7 days, but then it remembers when you last ran it):
  * `npm run recent`
* Validate the manifest against the schema:
  * `npm run schema`
* List some stats about the data set:
  * `npm run stats`
* Activate pre-commit hooks (requires Python):
  ```
  pip install --user pre-commit
  pre-commit install
  ```

There are some lower-level commands for finer control or full imports:

* Add new games to wiki-game-cache.yaml (required in order to add them to the manifest):
  * `npm run cache`
* Update the manifest with games from the cache:
  * All games in cache: `npm run manifest`
  * Specific games: `npm run manifest -- "Game 1" "Game 2"`

## API etiquette
When running or modifying the importer script, please be mindful not to
unnecessarily spam the PCGW or Steam APIs.

The [Mediawiki guidelines](https://www.mediawiki.org/wiki/API:Etiquette)
suggest that:

> Making your requests in series rather than in parallel, by waiting for one request
> to finish before sending a new request, should result in a safe request rate.

I am not sure about guidelines for the Steam API, but the cache file should mean
that we only ever need to reach out to Steam once per game.
