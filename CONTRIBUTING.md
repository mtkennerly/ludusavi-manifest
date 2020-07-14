## Development
Requires Node.js.

* Add new games to wiki-game-cache.yaml (required in order to add them to the manifest):
  * `npm run cache`
* Update the manifest with games from the cache (`--limit 25` is default at a time):
  * All games in cache: `npm run manifest -- --all`
  * Games already in the manifest: `npm run manifest -- --existing`
  * Games missing from manifest: `npm run manifest -- --missing`
  * Games not yet checked on the wiki: `npm run manifest -- --unchecked`
  * Games that had an unknown OS: `npm run manifest -- --unsuportedOs`
  * Games that had an unusable path: `npm run manifest -- --unsupportedPath`
  * Games with paths that are too broad and are tagged as such in the wiki cache: `npm run manifest -- --tooBroad`
  * Games with paths that are too broad and aren't already tagged as such in the wiki cache: `npm run manifest -- --tooBroadUntagged`
  * A specific game: `npm run manifest -- --game "Name of Game"`
* Validate the manifest against the schema:
  * `npm run schema`
* List some stats about the data set:
  * `npm run stats`

## API etiquette
When running or modifying the importer script, please be mindful not to
unnecessarily spam the PCGW or Steam APIs.

The [Mediawiki guidelines](https://www.mediawiki.org/wiki/API:Etiquette)
suggest that:

> Making your requests in series rather than in parallel, by waiting for one request
> to finish before sending a new request, should result in a safe request rate.

I am not sure about guidelines for the Steam API, but the cache file should mean
that we only ever need to reach out to Steam once per game.
